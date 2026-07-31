// Worker e2e 的绑定类型(P14.1)。
//
// `cloudflare:test` 导出的 `env` 类型是 `Cloudflare.Env`,不声明就是个空接口,
// 于是 `env.DB` / `env.BUCKET` 全是类型错误——这是 vitest-pool-workers 的标准接入步骤,
// 不是可省的样板:补齐之后 `.all<T>()` 的泛型也能正常推导,
// 那些 "Parameter 'r' implicitly has an 'any' type" 会一起消失。
//
// 注意增强的是**全局** `Cloudflare` 命名空间而不是 `ProvidedEnv`:0.19 起 `env` 换成了前者
// (旧文档与旧版本里是 `declare module 'cloudflare:test' { interface ProvidedEnv … }`,
// 照抄不会报错、但也完全不生效)。本文件有 import 因而是模块,所以必须包一层 declare global。
//
// 用别名导入是因为 @cloudflare/workers-types 里另有一个同名的全局 `Env`。
import type { Env as AppBindings } from '../src/types'

declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {
      /**
       * 应用里 `BUCKET?` 是可选的(生产可能没配 R2,附件功能会退化而不是崩)。
       * 但 `wrangler.test.toml` 一定声明了它,测试里收窄为必填,省得每处都判空——
       * 那种判空会把「真的没拿到 bucket」和「类型上可能没有」混成一件事。
       */
      BUCKET: R2Bucket
    }
  }
}

export {}
