import { describe, expect, it, vi } from 'vitest';
import { QuestCreationTools } from './quest-creation.js';
import type { FoundryClient } from '../foundry-client.js';
import type { Logger } from '../logger.js';

describe('quest page rename', () => {
  it('keeps the explicit page ID and appends content when also renaming', async () => {
    let content = '<p>Existing</p>';
    const query = vi.fn(async (method: string, data: any) => {
      if (method.endsWith('getJournalPageContent')) return { content, name: 'Renamed' };
      if (method.endsWith('updateJournalContent')) {
        content = data.content;
        return { success: true, pageId: data.pageId, pageName: data.newPageName };
      }
      throw new Error('Unexpected query');
    });
    const logger = {
      child() {
        return this;
      },
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as Logger;
    const tool = new QuestCreationTools({
      foundryClient: { query } as unknown as FoundryClient,
      logger,
    });
    const result = await tool.handleUpdateQuestJournal({
      journalId: 'j',
      pageId: 'p',
      newPageName: 'Renamed',
      newContent: 'New progress',
      updateType: 'progress',
    });
    expect(query).toHaveBeenCalledWith(
      'foundry-mcp-bridge.updateJournalContent',
      expect.objectContaining({ pageId: 'p', newPageName: 'Renamed' })
    );
    expect(content).toContain('<p>Existing</p>');
    expect(result).toMatchObject({ pageId: 'p', verified: true });
  });
});
