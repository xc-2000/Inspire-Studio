# New API 视频网关

Studio 的所有已迁入视频渠道只使用 `POST /v1/videos`、`GET /v1/videos/:id` 和 `GET /v1/videos/:id/content`。供应商协议适配由 New API 的任务插件执行：独立视频渠道使用 type 61，Arcads 图片与视频混合渠道使用 type 60。

## 维护入口

- 项目后台：系统管理 → 渠道中心 → New API。视频渠道选择“视频协议插件”，再选择协议。
- 完整 New API 控制台：`http://127.0.0.1:3005`。渠道地址、密钥、模型映射、优先级及插件版本均在 New API 维护。
- 插件源码：`plugins/video-adapter.mjs`。修改后执行 `node scripts/install-newapi-video-plugins.mjs`；安装器按内容生成版本并激活到该版本（仅注册不激活会让旧代码继续执行），不需要重建 Studio。
- New API 侧的媒体预处理：`helper/`。变更后只重建并启动 `newapi-video-helper`，不需要重建 Studio。

| 插件 | 上游行为 |
| --- | --- |
| studio-minimax | MiniMax H3 内容数组、首尾帧角色、480P/768P、查询与下载 |
| studio-openai | OpenAI 视频 multipart，图片 URL 数组 |
| studio-muse | Muse JSON、多参考图、10 秒提示词约束 |
| studio-autodl-comfyui | 工作流 ID、内联图片/音频、横竖分辨率、原始 Authorization |
| studio-dola | Dola 生成接口；`seedance-2.0`（10/15 秒）与 `seedance-2.5`（10/15/30 秒）走浏览器通道，`doubao-video-*` 原样透传走豆包 HTTP 通道（10/15 秒，30 秒仅 `doubao-video-2.5`）；支持参考图 |
| studio-openai-video-json | Seedance JSON、首尾帧、多图；Lumina 内部图片上传 |
| studio-arcads | Arcads JSON、首帧与多参考图、模型能力校验、签名成片下载 |
| studio-vivix | Vivix W1 UltraFast / Fast，5–15 秒、仅 720P、首帧、多参考图与首尾帧 |

`NEWAPI_LUMINA_UPLOAD_ORIGIN` 和 `NEWAPI_LUMINA_UPLOAD_TOKEN` 由 helper 使用，分别是允许的媒体上传站点和其独立上传令牌。安装器可从迁入前的本地配置复制。AutoDL 查询目标默认 `https://autodl.art`，可通过 `NEWAPI_AUTODL_BASE_URL` 调整。helper 不暴露宿主端口，只接受配置的上游地址。

AutoDL 的 `code:success` 返回格式与 New API 的历史透传格式冲突，helper 将其包装后交给插件解析，防止任务一直停在排队状态。

Arcads 设置 `NEWAPI_ARCADS_ORIGIN` 为其上游 origin。helper 只查询该地址，用渠道凭证获取成片重定向地址；网关下载签名对象时不附带渠道密钥。执行 `node scripts/install-arcads-channel.mjs` 安装并激活内容版本插件，再执行 `node scripts/sync-arcads-models.mjs` 接入业务模型。已有默认模型、别名和积分配置保留。Arcads 的 `minimax-h3` 映射到统一对外名称 `MiniMax-H3`。

Vivix 执行 `node scripts/install-vivix-channel.mjs` 安装插件、迁入已有 `vivix` 渠道并同步两个视频模型，保留渠道密钥和项目默认模型。仅启用 720P、并发 5、初始计费 10 积分/秒；再次执行保留已有模型别名和 720P 价格。支持文生视频、单首帧、多参考图（最多 5 张）和首尾帧；上传的本地图片优先于旧 URL。时长使用明确的 5–15 秒，暂不暴露上游自动时长及音频参考模式。视频仍由 Studio 的统一任务链路保存到 R2。

Vivix 图片由 `newapi-video-helper` 向 `/v1/files/images` 上传原始文件，再将返回的图片 URL 写入首帧、尾帧或参考图字段提交。上游 JSON 内联图片曾返回 30002，直接发送 `input_reference` 文件会被忽略；不能以任务成功代替图生视频模式校验。安装器写入 `NEWAPI_VIVIX_ORIGIN`，helper 只接受这个 origin。首次接入或修改上传逻辑后执行 `docker compose -f docker-compose-local.yml up -d --build --no-deps newapi-video-helper`；修改插件后重新执行安装器，无需重建 Studio。

Studio 渠道保留原 `apiFormat` 供界面展示参数预设；当地址为内嵌网关时，视频执行强制进入统一 New API 适配器，不执行原厂商适配器。旧直连配置加密保存，支持恢复。新协议的参数转换、查询及下载逻辑放在网关侧。

## 安装和迁移

```powershell
node scripts/setup-newapi.mjs --video-plugins
node scripts/install-newapi-video-plugins.mjs
docker compose -f docker-compose-local.yml up -d --build newapi-video-helper
node scripts/migrate-newapi-channels.mjs --apply
```

首次接入需部署一次 Studio 的统一客户端；之后更新网关插件无需改动 Studio。迁移会拒绝仍在生成的渠道，逐项校验模型配置、默认项和积分未变。包含自定义请求模板或混合配置的视频/文本渠道需先整理模型路由。

## 日常增删与变更保护

### 同名模型主用与备用

在“New API → 主用 / 备用”按模型展开渠道，点击“设为主用”手动切换。同名模型的所有渠道均保留，只有主用参与 Studio 请求，失败不自动切换供应商。新增的同名渠道默认作为备用；编辑保存也不会误启用备用模型。

“主用 / 备用”列表仅显示已启用的渠道；手动停用或异常停用的渠道不计入备用数量，只存在于停用渠道的模型整行隐藏。重新启用后恢复显示，原配置继续保留在“上游渠道”中。已启用的备用渠道仍可手动设为主用。

备用模型保存在渠道 `setting.studio_standby_models`，各渠道的模型能力、时长、分辨率和计费保存在 `studio_model_profiles`。部分备用时仅主用模型写入网关 `models`。全备用渠道因网关忽略空模型字符串，保留完整模型列表并移到 `studio-standby` 分组，用 `studio_standby_only` 和 `studio_active_groups` 记录状态；Studio 调用令牌只使用 `default` 分组。再次设为主用时恢复原分组。

切换会先检查未完成任务，再撤下原主用、应用目标能力配置并启用目标，最后回读验证。失败时恢复原路由和能力配置。使用该入口跨协议切换前，目标渠道必须具备对应模型的能力配置。

旧部署先执行 `node scripts/setup-newapi.mjs --channel-protection`，给现有管理令牌补上 New API 任务检查所需的 `log:read` 只读权限。令牌值不变，无需重启。新部署初始化时会自动包含此权限。

在项目渠道中心增加模型不会自动改写已接入模型的 ID、默认项、积分或历史记录；接入创作由管理员选择。已接入模型使用固定对外模型名，更换供应商时可在 New API 配置模型映射。

可直接在渠道中心缩减模型列表，包括移除最后一个可用渠道上的模型；无需先到“我的模型”删除业务配置。失去主用路由的模型自动从创作下拉框和 Agent 可选目录隐藏，历史记录、模型 ID、别名和积分配置保留；重新添加同名模型后恢复。备用渠道不会自动接管。删除整个渠道也不要求保留替代渠道，但仍需等待未完成任务结束。

启用和停用属于管理员即时控制，不受最后路由和未完成任务保护限制。停用只改变网关状态，保留模型、密钥、计费、默认项及历史记录，不取消已经提交给上游的任务；尚未提交的请求可能失败。重新启用时，如果同名模型已在其他渠道主用，该模型仍保留为备用，避免双主用。需要换供应商时使用“主用 / 备用”的“设为主用”。

模型下拉框和新建任务依据 Studio 调用令牌的 `/v1/models` 实时目录校验。没有启用路由的模型从图片、视频、文本和 Agent 可选项隐藏，恢复启用后重新出现。管理接口保留完整 `models` 并单独返回 `availableModels`；保存其他可选项不会删除隐藏模型的业务配置。默认模型不可用时不自动切换同名备用，管理员可手动选择其他已启用模型。网关目录读取失败时暂时隐藏网关模型，直连渠道不受影响。

后台模型配置的渠道后缀使用每个模型当前主用渠道的名称。用户创作界面仅显示模型别名或模型名称，选项与悬浮提示都不附加渠道名。`modelChannelNames` 是动态展示信息；内部网关 ID、地址和模型绑定保持不变。重命名渠道或手动切换主用后，后台重新读取配置即同步显示；已设置的模型别名仍优先使用。

更换地址、密钥、模型映射、协议或删除渠道时，同时检查 Studio 的排队/生成任务和 New API 该渠道的未完成任务；有任务则拒绝修改。仅增删模型列表或改名称、优先级无需中断任务；已提交任务仍按原渠道查询，尚未提交的下架模型请求可能失败。渠道修改、同步接入和迁移在本 Studio 实例内互斥，避免并发管理操作互相覆盖。

推荐顺序：新增同名备用渠道 → 配置并验证能力 → 等旧渠道任务结束 → 在“主用 / 备用”设为主用。旧渠道继续保留备用；不同供应商的时长、分辨率、参考图等能力随切换更新，别名和路由存在不代表上游一定可用。

这些检查适用于本项目的简洁管理 API；直接操作完整 New API 控制台/数据库、其他 Studio 实例或网关自动停用不受此保护。上游额度、故障、并发提交中的请求也无法仅靠配置检查保证零中断。网关协议升级应在 New API 侧完成，业务代码不需要跟随修改。

## 视频原生声音

新建视频任务默认携带 `generate_audio: true`，创作页、画布和 Agent 共用这条请求路径；旧客户端未提供该字段时，服务端也默认开启。网关按供应商协议转换，Seedance JSON 使用 `with_audio`，Arcads 兼容接口按模型能力转换为 `audioEnabled` 或 `generateAudio`。不支持这些字段的模型不强行添加，是否生成音轨仍取决于模型能力。

原生声音属于视频文件本身，不启用画布的独立配音工具。既有视频不受影响，静音视频需要重新生成。请求参数明确传 `false` 时仍保留静音语义，避免将 multipart 字符串 `"false"` 当作开启。

更新已安装的声音参数映射：`node scripts/enable-video-native-audio.mjs`。脚本备份插件、保留启停状态及渠道配置，并执行网关 dryrun；验证失败自动恢复原版本。Arcads 上游还需使用 `scripts/patch-arcads-native-audio.py` 对兼容接口生成候选文件，经 `newapi/plugins/test_arcads_native_audio.py` 验证后发布。补丁只转发原生音轨参数，不修改模型能力、参考音频或分辨率设置。

## 验证

```powershell
node scripts/test-newapi-video-plugins.mjs
node scripts/test-newapi-integration.mjs
node scripts/test-newapi-channel-protection.mjs
node --test newapi/plugins/arcads-video.test.mjs
node scripts/test-arcads-gateway.mjs
node --test newapi/plugins/vivix-video.test.mjs
npm --prefix newapi/helper test
docker build -f server/Dockerfile.newapi-tests -t inspirestudio-newapi-tests server
```

协议集成测试使用真实 New API 服务及本地模拟供应商，不发起付费生成。测试覆盖提交、轮询、鉴权下载、模型映射、30 秒、图片参数、迁移和恢复。下载失败时 Studio 保存 New API 任务 ID 并恢复同一任务，只有上游明确生成失败才允许重下单。

Vivix 真实生成验收需显式执行 `node scripts/test-vivix-integration.mjs --generate vivix-w1-ultrafast`（5 秒 720P 文生视频）或 `--generate vivix-w1-fast`（5 秒 720P 图生视频），会调用上游并消耗额度。已有任务只用 `--task <taskId>` 恢复查询，不重复提交；结果报告保存在 `tmp/vivix-integration/`。

两个模型均可通过 `--mode text-to-video` 或 `--mode image-to-video` 指定测试模式。例如 UltraFast 图生视频：`node scripts/test-vivix-integration.mjs --generate vivix-w1-ultrafast --mode image-to-video`。
