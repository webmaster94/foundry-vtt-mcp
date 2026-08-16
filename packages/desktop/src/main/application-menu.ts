import type { MenuItemConstructorOptions } from 'electron';

export interface ApplicationMenuActions {
  hide(): void;
  exit(): void;
  editConnections(): void;
  about(): void;
  openDocumentation(): void;
  reportIssue(): void;
}

export function createApplicationMenuTemplate(
  actions: ApplicationMenuActions,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (platform === 'darwin') {
    template.push({
      label: 'FoundryVTT MCP Bridge',
      submenu: [
        { label: 'About FoundryVTT MCP Bridge', click: () => actions.about() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Exit', accelerator: 'Cmd+Q', click: () => actions.exit() },
      ],
    });
  }

  template.push(
    {
      label: 'File',
      submenu: [
        { label: 'Hide to Notification Area', click: () => actions.hide() },
        { type: 'separator' },
        {
          label: 'Exit',
          ...(platform === 'darwin' ? {} : { accelerator: 'Ctrl+Q' }),
          click: () => actions.exit(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Server Connections…',
          accelerator: 'CmdOrCtrl+,',
          click: () => actions.editConnections(),
        },
        { type: 'separator' },
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => actions.openDocumentation() },
        { label: 'Report an Issue', click: () => actions.reportIssue() },
        { type: 'separator' },
        { label: 'About FoundryVTT MCP Bridge', click: () => actions.about() },
      ],
    }
  );
  return template;
}
