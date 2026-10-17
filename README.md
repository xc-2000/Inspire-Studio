# Inspire Studio

AI 图片、视频、画布 Agent、电商创作与多平台发布工作台。


## 仓库内容

- `web/`：Next.js 前端、页面样式、必要的图标、字体和入口配图。
- `server/`：Java 21 / Spring Boot 后端、表结构迁移和系统提示词。
- `newapi/`：New API 视频适配插件和媒体上传辅助服务。
- `publisher-service/`：多平台发布服务和相关第三方适配代码。
- `scripts/`、`nginx/`、Docker Compose：配置和部署工具。
<img width="1920" height="1032" alt="image" src="https://github.com/user-attachments/assets/585b54db-0ee4-4748-9a31-069b6e30726f" />
<img width="1906" height="932" alt="image" src="https://github.com/user-attachments/assets/0d6dce2a-9953-4807-bb87-33860fce60b0" />
<img width="1912" height="947" alt="image" src="https://github.com/user-attachments/assets/7b4eca8a-5da0-4de0-b32b-13ef1805d027" />
<img width="1892" height="476" alt="image" src="https://github.com/user-attachments/assets/24b1ad62-83eb-4595-8f66-067bc810c83a" />

## 从源码部署

需要 Docker / Docker Compose，以及 Node.js 22 或更高版本（用于初始化 New API）。

1. 复制 `.env.example` 为 `.env`，填写自己的配置，至少包含：
   - `APP_SECRET_KEY`：至少 32 字节的随机密钥。
   - `POSTGRES_PASSWORD`、`PUBLISHER_INTERNAL_TOKEN`：独立随机值。
   - `ADMIN_INITIAL_EMAIL`、`ADMIN_INITIAL_PASSWORD`：新环境的初始管理员。
   - `FRONTEND_BASE_URL`：实际访问地址。
2. 初始化 New API 的本地配置：

   ```sh
   node scripts/setup-newapi.mjs --prepare
   docker compose -f docker-compose-local.yml up -d newapi postgres redis
   node scripts/setup-newapi.mjs
   ```

3. 构建并启动应用：

   ```sh
   docker compose -f docker-compose-local.yml up -d --build
   ```

4. 默认访问 `http://localhost:5550`。首次启动会按 `.env` 创建新的管理员。登录后台后配置模型渠道、对象存储、邮件、支付及内容；这些配置都保存在各自部署环境中。

本地 Compose 的 Web 入口仅绑定 `127.0.0.1`；服务器部署请使用 HTTPS 反向代理。`docker-compose.yml` 是另一种外部 Nginx 部署方式，启用前需要自行配置相应目录。

> 这份源码中的迁移已移除历史内容导入，只用于全新数据库。不要把它直接接到已有数据库执行 Flyway，也不要用它覆盖现有环境的迁移历史。

## 开发与检查

```sh
cd web
corepack enable
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm test:node src/features/homepage/api/homepage-showcases.test.ts
```

服务端使用 Java 21 和 Maven。网关插件的离线测试示例：

```sh
node --test newapi/plugins/*.test.mjs
```

部分历史导入脚本需要额外的、由部署者自行提供的素材源；仓库不附带这些导入数据。不要提交运行时生成的 `newapi/generated/`、`outputs/` 或 `.env`。`.gitignore` 已覆盖常见运行数据与密钥文件。

## 许可证

本项目原创且有权授权的代码以 **[GNU AGPLv3（AGPL-3.0-only）]** 发布。

- **修改后对外提供在线服务**：对于受 AGPLv3 覆盖的修改版，必须显著地向所有远程交互用户提供免费获取对应源码的机会；对应源码的范围及所需的构建、安装脚本依许可证正文确定。
- **分发程序或修改版**：按对应许可证保留版权和许可声明、标注修改，并履行源码提供义务；不得给接收者附加与许可证冲突的限制。
- **私下修改、自用**：不因修改行为本身而要求向全社会公开源码；允许商业使用，商业使用也须遵守相同条款。
- **源码不等于业务数据**：无需公开用户数据、数据库内容、API 密钥、Cookie 或私钥。提交可配置的源码和配置模板即可，不应把运行凭证打包进去。

部署者应提供实际运行版本的源码下载入口；用户无权访问的私有仓库链接不能替代该入口。以上为说明，准确权利义务以许可证全文为准。
