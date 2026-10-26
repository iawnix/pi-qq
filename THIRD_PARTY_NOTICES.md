# Third-party notices

pi-qq 的原创代码采用仓库根目录中的 MIT License。第三方软件继续遵循各自的许可证，本项目的许可证不会替代其授权条款。

## 依赖范围

本仓库通过 npm 引用依赖，没有将 node_modules 或第三方源码、二进制复制到仓库。TypeScript 构建输出保留外部依赖导入，不把依赖打包进项目代码。下文保留原有 MIT 依赖的许可原文；新增图片处理依赖的许可证与原生库声明见下一节。

完整依赖版本及许可证标识见 package-lock.json。当前锁文件还包含使用 Apache-2.0、BSD-3-Clause、ISC、0BSD、Unlicense、BlueOak-1.0.0 和 LGPL-3.0-or-later 的间接或开发依赖；这些依赖不因此转为 MIT。分发包含依赖的镜像、安装目录或合并产物时，须保留各依赖随附的 LICENSE、版权声明及适用的 NOTICE。

## 图片处理依赖与运行时

- **sharp 0.35.5**：Copyright 2013 Lovell Fuller and others. Apache-2.0，[上游](https://github.com/lovell/sharp/tree/v0.35.5)，[许可原文](docs/licenses/sharp-Apache-2.0.txt)。使用其图片解码、尺寸限制、缩放及元数据去除能力。
- **ipaddr.js 2.5.0**：MIT，[上游](https://github.com/whitequark/ipaddr.js)，[版权与许可原文](docs/licenses/ipaddr-MIT.txt)。用于下载地址分类。
- **sharp 的平台原生依赖**：由 npm 根据系统安装。本次 Linux x64 验证使用 `@img/sharp-libvips-linux-x64@1.3.4`，包标注 LGPL-3.0-or-later，其内部还包含其他许可证的库。已保留该包的[原始组件许可清单](docs/licenses/sharp-libvips-linux-x64-1.3.4.md)；其他平台应以对应包随附声明为准。源码与构建配方见 [sharp-libvips v1.3.4](https://github.com/lovell/sharp-libvips/tree/v1.3.4) 和 [libvips](https://github.com/libvips/libvips)。这些原生库没有被复制进本仓库或 pi-qq 安装包，也不适用本项目的 MIT 许可证。若自行分发含原生库的镜像或安装目录，需另行满足 LGPL 的源码、修改/重新链接等适用要求及其他组件的许可条件。
- **SQLite**：通过 Node.js 内置 `node:sqlite` 使用，不另外打包 SQLite；其随 Node.js 的分发条款与第三方声明仍适用。Node 22.19 中此 API 可能输出实验性功能提示。

## 设计参考

- [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)：参考了通道适配和消息交互设计，未搬入其实现代码。[MIT License](https://github.com/tencent-connect/openclaw-qqbot/blob/89988812442583bf47c34b89f9abf5fd4b85df0b/LICENSE)，Copyright (c) 2026 sliverp; Copyright (c) 2026 Tencent Connect。
- [tencent-connect/qqbot-agent-sdk](https://github.com/tencent-connect/qqbot-agent-sdk)：作为 SDK 选型研究对象，未作为依赖或复制其代码。[MIT License](https://github.com/tencent-connect/qqbot-agent-sdk/blob/6163b5dc979a2f12379b1916805009075008c3c3/LICENSE)，Copyright (c) 2025 walli。

## 直接运行时与 peer 依赖

### @tencent-connect/qqbot-nodejs 1.0.5

Source: https://github.com/tencent-connect/qqbot-nodejs

```text
MIT License

Copyright (c) 2026 Tencent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### @earendil-works/pi-coding-agent 1.4.0

Source: https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### proper-lockfile 4.1.2

Source: https://github.com/moxystudio/node-proper-lockfile

```text
The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### zod 4.6.7

Source: https://github.com/colinhacks/zod

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### typebox 1.3.27

Source: https://github.com/sinclairzx81/typebox

```text
TypeBox

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
