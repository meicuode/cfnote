// simple-mind-map 的 npm 包类型声明无法被 tsc 解析,这里做最小声明(预览 + 基础编辑用)
declare module 'simple-mind-map' {
  export default class MindMap {
    constructor(options: Record<string, unknown>)
    static usePlugin(plugin: unknown): void
    view?: { fit: () => void }
    getData(withConfig?: boolean): any
    setData(data: any): void
    setMode(mode: 'readonly' | 'edit'): void
    export(type: string, isDownload?: boolean, name?: string): Promise<string>
    on(event: string, handler: (...args: any[]) => void): void
    off(event: string, handler: (...args: any[]) => void): void
    destroy(): void
  }
}

declare module 'simple-mind-map/src/plugins/Drag.js' {
  const Drag: unknown
  export default Drag
}

declare module 'simple-mind-map/src/plugins/Export.js' {
  const Export: unknown
  export default Export
}
