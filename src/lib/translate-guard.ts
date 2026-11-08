// 浏览器整页翻译防崩。
// Chrome / Google 翻译会把页面文字换成它自己的 <font> 节点，连带把句子里的行内元素挪进去。React 之后再改这一块
// （选完照片、换风格、余额变化……）时，要插入 / 删除的参照节点已经不在原来的父节点下，浏览器抛
// NotFoundError: insertBefore / removeChild … not a child of this node，整页被根路由错误边界换成错误页。
// 做法照 React issue #11538 的通用补丁：参照节点不在这个父节点下时，改为插到它现在所在的那个直接子节点前面
// （找不到就追加到末尾）；要删的节点已经被挪走就从它现在的父节点删、已脱离文档就当删过了——翻译照常可用，React 不再崩
export function installTranslateGuard() {
  if (typeof Node !== 'function' || !Node.prototype) return
  const proto = Node.prototype as Node & { __translateGuard?: boolean }
  if (proto.__translateGuard) return
  proto.__translateGuard = true

  const originalRemoveChild = proto.removeChild
  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      if (child.parentNode && this.contains(child)) return child.parentNode.removeChild(child)
      return child
    }
    return originalRemoveChild.call(this, child) as T
  }

  const originalInsertBefore = proto.insertBefore
  proto.insertBefore = function <T extends Node>(this: Node, node: T, reference: Node | null): T {
    if (reference && reference.parentNode !== this) {
      let anchor: Node | null = reference
      while (anchor && anchor.parentNode !== this) anchor = anchor.parentNode
      return originalInsertBefore.call(this, node, anchor) as T
    }
    return originalInsertBefore.call(this, node, reference) as T
  }
}
