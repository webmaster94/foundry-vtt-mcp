import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationMenuTemplate } from '../src/main/application-menu.js';

function menuItems(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  const item = template.find(entry => entry.label === label);
  if (!item || !Array.isArray(item.submenu)) throw new Error(`Missing ${label} menu`);
  return item.submenu;
}

function click(items: MenuItemConstructorOptions[], label: string): void {
  const item = items.find(entry => entry.label === label);
  if (!item || typeof item.click !== 'function') throw new Error(`Missing ${label} action`);
  (item.click as () => void)();
}

describe('application menu', () => {
  it('provides the requested File, Edit, and Help actions on Windows', () => {
    const actions = {
      hide: vi.fn(),
      exit: vi.fn(),
      editConnections: vi.fn(),
      about: vi.fn(),
      openDocumentation: vi.fn(),
      reportIssue: vi.fn(),
    };
    const template = createApplicationMenuTemplate(actions, 'win32');

    expect(template.map(item => item.label)).toEqual(['File', 'Edit', 'Help']);
    click(menuItems(template, 'File'), 'Exit');
    click(menuItems(template, 'Edit'), 'Server Connections…');
    click(menuItems(template, 'Help'), 'About FoundryVTT MCP Bridge');
    expect(actions.exit).toHaveBeenCalledOnce();
    expect(actions.editConnections).toHaveBeenCalledOnce();
    expect(actions.about).toHaveBeenCalledOnce();
  });

  it('adds the native application menu on macOS', () => {
    const noop = vi.fn();
    const template = createApplicationMenuTemplate(
      {
        hide: noop,
        exit: noop,
        editConnections: noop,
        about: noop,
        openDocumentation: noop,
        reportIssue: noop,
      },
      'darwin'
    );

    expect(template.map(item => item.label)).toEqual([
      'FoundryVTT MCP Bridge',
      'File',
      'Edit',
      'Help',
    ]);
  });
});
