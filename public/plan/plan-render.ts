import { el } from '../dom-helpers.ts';
import type { PlanBlock, PlanInline, PlanListItem } from './plan-markdown-core.ts';

function appendInline(parent: HTMLElement, nodes: readonly PlanInline[]) {
  for (const node of nodes) {
    if (node.type === 'text') {
      parent.append(document.createTextNode(node.text));
      continue;
    }
    if (node.type === 'code') {
      parent.append(el('code', 'plan-inline-code', node.text));
      continue;
    }
    if (node.type === 'emphasis') {
      const emphasis = el('em');
      appendInline(emphasis, node.children);
      parent.append(emphasis);
      continue;
    }
    if (node.type === 'strong') {
      const strong = el('strong');
      appendInline(strong, node.children);
      parent.append(strong);
      continue;
    }
    const link = el('a', 'plan-link');
    link.href = node.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    appendInline(link, node.children);
    parent.append(link);
  }
}

function renderListItem(item: PlanListItem) {
  const row = el('li');
  appendBlocks(row, item.children);
  return row;
}

function appendBlocks(parent: HTMLElement, blocks: readonly PlanBlock[]) {
  for (const block of blocks) {
    if (block.type === 'heading') {
      const heading = el(`h${block.level}` as keyof HTMLElementTagNameMap, 'plan-heading');
      heading.id = block.id;
      appendInline(heading, block.children);
      parent.append(heading);
      continue;
    }
    if (block.type === 'paragraph') {
      const paragraph = el('p', 'plan-paragraph');
      appendInline(paragraph, block.children);
      parent.append(paragraph);
      continue;
    }
    if (block.type === 'list') {
      const list = block.ordered ? el('ol', 'plan-list') : el('ul', 'plan-list');
      list.append(...block.items.map(renderListItem));
      parent.append(list);
      continue;
    }
    if (block.type === 'code') {
      const pre = el('pre', 'plan-code');
      const code = el('code', block.language ? `language-${block.language}` : null, block.text);
      pre.append(code);
      parent.append(pre);
      continue;
    }
    if (block.type === 'table') {
      const tableWrap = el('div', 'plan-table-wrap');
      const table = el('table', 'plan-table');
      const head = el('thead');
      const headRow = el('tr');
      for (const cell of block.header) {
        const headingCell = el('th');
        appendInline(headingCell, cell);
        headRow.append(headingCell);
      }
      head.append(headRow);
      const body = el('tbody');
      for (const row of block.rows) {
        const bodyRow = el('tr');
        for (const cell of row) {
          const bodyCell = el('td');
          appendInline(bodyCell, cell);
          bodyRow.append(bodyCell);
        }
        body.append(bodyRow);
      }
      table.append(head, body);
      tableWrap.append(table);
      parent.append(tableWrap);
      continue;
    }
    if (block.type === 'blockquote') {
      const quote = el('blockquote', 'plan-blockquote');
      appendBlocks(quote, block.blocks);
      parent.append(quote);
      continue;
    }
    parent.append(el('hr', 'plan-rule'));
  }
}

export function renderPlanBlocks(blocks: readonly PlanBlock[]): HTMLElement {
  const root = el('div', 'plan-document');
  appendBlocks(root, blocks);
  return root;
}
