# Inspire Studio — 许可与来源

## 授权范围

本项目原创且项目维护者有权授权的代码，自本次许可声明起采用 GNU Affero General Public License version 3 only（`AGPL-3.0-only`）。完整、未经改写的官方文本位于根目录 `LICENSE`。

这不是对第三方代码的单方面重新授权：

1. 沿用的 novanova-studio / Inspire Studio 上游代码，及受其 GPLv3 约束的派生修改，继续使用原 GPLv3。原根目录许可证逐字保存在 `LICENSES/GPL-3.0.txt`，原有版权和许可声明继续有效。
2. `web/src/features/canvas/infinite-agent/upstream/` 来自 [tigerowo/infinite-canvas](https://github.com/tigerowo/infinite-canvas)，保留该目录中的 AGPLv3 和来源说明。
3. `web/src/features/canvas/infinite-agent/tapcanvas/` 来自 [anymouschina/TapCanvas](https://github.com/anymouschina/TapCanvas)，保留该目录中的 MIT 许可证和来源说明。
4. 发布适配器、图片反推组件及其他第三方依赖、字体、配图，保留各自随附的许可。参考各组件目录中的 `LICENSE` / `README`、`server/src/main/resources/licenses/` 和 `web/public/homepage/entries/CREDITS.md`。

GPLv3 与 AGPLv3 代码依据两份许可证第 13 条组合使用。GPLv3 部分仍受 GPLv3 管辖；AGPLv3 对远程交互、提供对应源码的要求适用于该组合。这里没有声称可以改写或移除任何上游许可证。

## 对应源码的提供

分发受覆盖的程序时，须依许可证履行对应源码及许可通知义务。修改受 AGPLv3 覆盖的程序并允许用户远程交互时，须显著地向这些用户提供从网络服务器免费取得该版本对应源码的机会，包括修改及所需的构建、安装脚本。只提供一个用户无法访问的私有仓库地址不满足这种提供方式。

这些要求不意味着任何私下修改都必须立即发布到公开 GitHub 仓库，也不要求公开业务数据、用户信息或运行凭证。协议允许商业使用；对应源码的范围和具体交付要求以许可证正文为准。

## 许可说明修正

初始源码导入的 README 曾将继承的根目录许可证误标为 AGPL；该文件实际为 GPLv3。本次保留原 GPLv3 文本，并明确项目中 AGPLv3、GPLv3 和其他第三方许可的适用范围。

官方文本与说明：

- [GNU AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html)
- [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)
- [GNU：GPLv3 与 AGPLv3 的组合](https://www.gnu.org/licenses/gpl-faq.html#v3Notwithstanding)
