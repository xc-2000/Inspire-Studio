# 内嵌 New API 渠道中心

入口：系统管理 → **New API**，或 `/admin/system?tab=newapi`。

## 架构

Studio 管理页 → 带管理员权限的后端接口 → 官方 New API 独立容器。
生成请求通过内部 `http://newapi:3000/v1` 转发。渠道密钥保存在 New API，
管理令牌仅由 Studio 后端使用，不发送到浏览器。原有图片、视频、Agent、积分与资产流程继续使用现有服务。

固定镜像：`calciumion/new-api:v1.0.0-rc.42`。

## 本地安装

在项目根目录依次运行：

```powershell
node scripts/setup-newapi.mjs --prepare
docker compose -f docker-compose-local.yml up -d newapi
node scripts/setup-newapi.mjs
docker compose -f docker-compose-local.yml build server web
docker compose -f docker-compose-local.yml up -d --no-deps server web
docker compose -f docker-compose-local.yml exec nginx nginx -s reload
```

初始化生成随机管理员密码、会话密钥、仅含渠道管理权限的管理令牌，以及独立的调用令牌；
写入已被 Git 忽略的 `.env`。脚本重跑不会清空渠道或覆盖已有令牌。
完整控制台位于 `http://127.0.0.1:3005`，账号和密码为本地 `.env` 中的
`NEWAPI_ADMIN_USERNAME`、`NEWAPI_ADMIN_PASSWORD`。

New API 使用 SQLite，数据保存在 `volume/newapi`。该内嵌实例关闭注册，
default 分组的计费倍率为 0，用户积分仍由 Studio 结算。
备份时保存数据库、`.env`、New API 数据目录和应用加密密钥。

服务器部署时将此 sidecar 和 server 的 `NEWAPI_*` 环境配置合并进部署 Compose，
保持在同一私有网络。完整管理控制台默认仅监听服务器回环地址，不应直接公开。

## 使用

1. **新增渠道**：选择渠道类型，填入上游地址和密钥，拉取或手动填写模型。
   地址末尾的 `/v1` 会自动规范化；自定义路径前缀保留。
2. **接入创作**：在可用模型中勾选，选择类型和实际能力，以及图片/视频的初始积分。
   文本沿用 Token 定价，接入后在模型积分设置中配置官方价格和倍率。
   未配置 Token 价格时仍按项目既有逻辑免费。
3. **后续维护**：在内嵌页修改上游密钥、地址、模型映射、权重、优先级、启停。
   同名模型的渠道分配由 New API 处理；新增模型需执行一次接入。
4. **迁入已有渠道**：兼容的 OpenAI 文本/图片渠道和 New API 渠道可一键迁入并接管。
   原模型 ID、默认状态、积分、能力、历史引用保持不变。
   有等待/运行任务时阻止迁移。重复迁入按本地记录和上游标签去重。
5. **恢复直连**：读取加密备份，恢复原地址和密钥。保留 New API 中的渠道。

删除/停用上游渠道不会删除 Studio 的模型定价。
如果没有同模型的其他可用上游，相关模型无法生成；可恢复上游，或在模型设置中移除相应选项。

## 兼容范围

- 文本通过 OpenAI Chat 兼容接口转发。
- 图片通过 New API 的 Images 接口转发。
- 视频通过现有 New API 适配器的 `/v1/video/generations` 协议提交和轮询。
- Muse、Dola、Siftq H3、AutoDL 工作流以及自定义请求模板不自动迁移。
  它们需要 New API 中相应的原生适配器或任务插件，不能仅改 Base URL。
- 内嵌页聚焦 default 分组和常用渠道；复杂分组、任务插件等使用完整 New API 控制台。

## 验证

```powershell
docker build -f server/Dockerfile.newapi-tests -t inspirestudio-newapi-tests:local server
node scripts/test-newapi-integration.mjs
```

集成测试使用本地模拟上游，不产生模型供应商费用；覆盖 CRUD、分页、密钥脱敏、
模型拉取、启停、三类模型接入、重复同步保留价格、HTTP 转发、迁入及恢复直连。
测试会清理自身创建的渠道和模型，不改变已有默认模型。

## 开源组件

[New API](https://github.com/QuantumNous/new-api) © QuantumNous 及其贡献者，
采用 [AGPL-3.0 及附加条款](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.42/LICENSE)。
此集成使用官方容器和 HTTP 接口；管理界面为本项目独立实现，保留组件来源标识。
