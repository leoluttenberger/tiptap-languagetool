import { Extension, NodeWithPos, Predicate } from '@tiptap/core'
import { Decoration, DecorationSet, EditorView, InlineDecorationSpec } from 'prosemirror-view'
import { Plugin, PluginKey, TextSelection, Transaction, EditorState } from 'prosemirror-state'
import { Node as ProsemirrorNode } from 'prosemirror-model'
import { debounce } from 'lodash'
import { LanguageToolResponse, Match } from '../../types'
import { v4 as uuidv4 } from 'uuid'

const isTargetNodeOfType = (node: ProsemirrorNode, typeNames: string[]) => typeNames.includes(node.type.name)

const isNodeHasAttribute = (node: ProsemirrorNode, attrName: string) => Boolean(node.attrs && node.attrs[attrName])

let editorView: EditorView

let gaveIdsOnCreation = false

interface DecorationAndContent {
  matches: Match[]
  textContent: string
}

const nodeIdsList: string[] = []

const savedNodesWithDecorationsAndContent: Record<string, DecorationAndContent> = {}

const cleanSavedDecorations = () => {
  for (const id of Object.keys(savedNodesWithDecorationsAndContent)) {
    if (!nodeIdsList.includes(id)) delete savedNodesWithDecorationsAndContent[id]
  }
}

const getDecorations = (doc: ProsemirrorNode): Decoration[] => {
  // cleanSavedDecorations()
  const decos: Decoration[] = []

  const blockNodes = findBlockNodes(doc)

  blockNodes.forEach(({ node, pos }) => {
    pos = pos + 1
    const matches = savedNodesWithDecorationsAndContent[node.attrs.ltuuid]?.matches

    if (matches) {
      for (const match of matches) {
        const from = pos + match.offset
        const to = from + match.length

        // debugger;

        const decoration = Decoration.inline(from, to, {
          class: `lt lt-${match.rule.issueType}`,
          nodeName: 'span',
          match: JSON.stringify(match),
        })

        decos.push(decoration)
      }
    }
  })

  return decos
}

const flatten = (node: ProsemirrorNode) => {
  if (!node) throw new Error('Invalid "node" parameter')

  const result: { node: ProsemirrorNode; pos: number }[] = []

  node.descendants((child, pos) => {
    result.push({ node: child, pos: pos })
  })

  return result
}

const findChildren = (node: ProsemirrorNode, predicate: Predicate): NodeWithPos[] => {
  if (!node) throw new Error('Invalid "node" parameter')
  else if (!predicate) throw new Error('Invalid "predicate" parameter')

  return flatten(node).filter((child) => predicate(child.node))
}

const findBlockNodes = (node: ProsemirrorNode): NodeWithPos[] => findChildren(node, (child) => child.isBlock)

const setLTIds = (transactions: Transaction[], nextState: EditorState, force = false) => {
  const ltUuidAttr = 'ltuuid'
  let tr = nextState.tr
  let modified = false

  if (transactions?.some((transaction) => transaction.docChanged) || !gaveIdsOnCreation || force) {
    // Adds a unique id to a node
    nextState.doc.descendants((node, pos) => {
      if (isTargetNodeOfType(node, ['paragraph', 'heading']) && !isNodeHasAttribute(node, ltUuidAttr)) {
        const attrs = node.attrs

        tr = tr.setNodeMarkup(pos, undefined, { ...attrs, [ltUuidAttr]: uuidv4() })
        modified = true
      }
    })

    if (!gaveIdsOnCreation) gaveIdsOnCreation = true

    if (force) editorView.dispatch(tr)
  }

  return modified ? tr : null
}

enum LanguageToolWords {
  TransactionMetaName = 'languageToolDecorations',
}

interface LanguageToolPromiseResult {
  item: NodeWithPos
  languageToolResponse: LanguageToolResponse
}

const createDecorationsAndUpdateState = ({ languageToolResponse, item }: LanguageToolPromiseResult): void => {
  if (!gaveIdsOnCreation) {
    setTimeout(() => createDecorationsAndUpdateState({ languageToolResponse, item }), 200)
    return
  }

  const view = editorView
  const { state } = view

  const decorations: Decoration<{ [key: string]: string } & InlineDecorationSpec>[] = []

  const pos = item.pos + 1
  const matches = languageToolResponse.matches

  for (const match of matches) {
    const from = pos + match.offset
    const to = from + match.length

    // debugger;

    const decoration = Decoration.inline(from, to, {
      class: `lt lt-${match.rule.issueType}`,
      nodeName: 'span',
      match: JSON.stringify(match),
    })

    decorations.push(decoration)
  }

  savedNodesWithDecorationsAndContent[item.node.attrs.ltuuid] = {
    matches,
    textContent: item.node.textContent,
  }

  // debugger

  view.dispatch(state.tr.setMeta(LanguageToolWords.TransactionMetaName, true))
}

const apiRequest = (doc: ProsemirrorNode, apiUrl: string) => {
  const blockNodes = findBlockNodes(doc)
    .filter((item) => item.node.isTextblock && !item.node.type.spec.code && item.node.textContent.length)
    .filter((n) => n.node.textContent !== savedNodesWithDecorationsAndContent[n.node.attrs.ltuuid]?.textContent)

  // debugger

  blockNodes.forEach(async (item) => {
    const languageToolResponse: LanguageToolResponse = await (await fetch(`${apiUrl}${item.node.textContent}`)).json()

    createDecorationsAndUpdateState({ item, languageToolResponse })
  })
}

const debouncedApiRequest = debounce(apiRequest, 1000)

interface LanguageToolOptions {
  language: string
  apiUrl: string
}

export const LanguageTool = Extension.create<LanguageToolOptions>({
  name: 'languagetool',

  addOptions() {
    return {
      language: 'en-US',
      apiUrl: process.env.VUE_APP_LANGUAGE_TOOL_URL + '/check',
    }
  },

  addStorage() {
    return {
      // TODO: use this to give the access of LT results outside of tiptap
    }
  },

  addProseMirrorPlugins() {
    const { language, apiUrl } = this.options

    return [
      new Plugin({
        key: new PluginKey('languagetool'),
        props: {
          decorations(state) {
            return this.getState(state)
          },
          attributes: {
            spellcheck: 'false',
          },
          handleDOMEvents: {
            // TODO: check this out for the hover on current decoration
            // contextmenu: (view, event) => {
            //   const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            //   if (pos === undefined) return
            //   const { decorations, matches } = this.getState(view.state)
            //   const deco = (decorations as DecorationSet).find(pos, pos)[0]
            //   if (!deco) return false
            //   const match = matches[deco.spec.id]
            //   const selectionTransaction = view.state.tr.setSelection(
            //     TextSelection.create(view.state.doc, deco.from, deco.to),
            //   )
            //   view.dispatch(selectionTransaction)
            //   const dialog = new DialogLT(options.editor, view, match)
            //   dialog.init()
            //   event.preventDefault()
            //   return true
            // },
          },
        },
        state: {
          init: (config, state) => {
            const finalUrl = `${apiUrl}?language=${language}&text=`

            if (gaveIdsOnCreation) setLTIds([], state, true)

            return DecorationSet.create(state.doc, [])
          },
          apply: (tr, decorationSet) => {
            const languageToolDecorations = tr.getMeta(LanguageToolWords.TransactionMetaName)

            if (languageToolDecorations) {
              // debugger
              const decos = getDecorations(tr.doc)
              return DecorationSet.create(tr.doc, decos)
            }

            if (tr.docChanged) debouncedApiRequest(tr.doc, `${apiUrl}?language=${language}&text=`)

            decorationSet = decorationSet.map(tr.mapping, tr.doc)

            return decorationSet
          },
        },
        view: (view) => {
          return {
            update(view) {
              editorView = view
            },
          }
        },
        appendTransaction: (transactions, prevState, nextState) => setLTIds(transactions, nextState),
      }),
    ]
  },
})
