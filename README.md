# Inspire Studio

AI 图片、视频、画布 Agent、电商创作与多平台发布工作台。

本仓库是**不含已有数据的源码版本**，从全新的 Git 历史开始。

## 仓库内容

- `web/`：Next.js 前端、页面样式、必要的图标、字体和入口配图。
- `server/`：Java 21 / Spring Boot 后端、表结构迁移和系统提示词。
- `newapi/`：New API 视频适配插件和媒体上传辅助服务。
- `publisher-service/`：多平台发布服务和相关第三方适配代码。
- `scripts/`、`nginx/`、Docker Compose：配置和部署工具。

不包含数据库文件或备份、用户/账号信息、订单/积分记录、画布项目、生成历史、上传文件、视频/音频、Cookie、支付证书、渠道密钥、真实 `.env`、运行日志及构建产物。历史提示词库、技能导入集合、风格素材、首页示例影片也不随源码发布；相应功能保留，内容可在独立部署后配置。

数据库迁移只建立表结构及程序必需的默认设置（空的邮箱白名单、支付开关等），不会导入现有用户或业务记录。首页没有预置作品时显示空状态。

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

## 许可证与来源

保留上游项目的 [AGPL-3.0 许可证](LICENSE)。第三方适配组件和资源遵循各自的许可证；详见 `server/src/main/resources/licenses/`、`publisher-service/vendor/`、`third-party/image-prompt-reverse/` 及 `web/public/homepage/entries/CREDITS.md`。
