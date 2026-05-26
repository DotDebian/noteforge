/**
 * CodeBlockLowlight + a Vue NodeView. The NodeView renders the editable
 * code (lowlight syntax highlighting still applies via decorations on the
 * contentDOM) and, when `language === 'mermaid'`, a live SVG preview
 * underneath.
 */
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import CodeBlockNodeView from '../CodeBlockNodeView.vue'

export const CodeBlockWithMermaid = CodeBlockLowlight.extend({
  addNodeView() {
    return VueNodeViewRenderer(CodeBlockNodeView)
  },
})
