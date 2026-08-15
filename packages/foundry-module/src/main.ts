import { CONNECTION_STATES, MODULE_ID } from './constants.js';
import { SocketBridge } from './socket-bridge.js';
import { QueryHandlers } from './queries.js';
import { ModuleSettings } from './settings.js';
import { CampaignHooks } from './campaign-hooks.js';
import { browserConsoleCapture, type BrowserConsoleCapture } from './console-capture.js';
import {
  ConsoleCaptureLifecycle,
  type ConsoleCaptureActivityToken,
} from './console-capture-lifecycle.js';
import { eventService } from './event-service.js';
import { ConnectionRecoveryController } from './connection-recovery.js';
// Connection control now handled through settings menu

/**
 * Main Foundry MCP Bridge Module Class
 */
class FoundryMCPBridge {
  private settings: ModuleSettings;
  private queryHandlers: QueryHandlers;
  private campaignHooks: CampaignHooks;
  public consoleCapture: BrowserConsoleCapture;
  private captureLifecycle: ConsoleCaptureLifecycle;
  private socketBridge: SocketBridge | null = null;
  private isInitialized = false;
  private heartbeatInterval: number | null = null;
  private lastActivity: Date = new Date();
  private isConnecting = false;
  private connectionGeneration = 0;
  private connectionRecovery: ConnectionRecoveryController;

  constructor() {
    this.settings = new ModuleSettings();
    this.queryHandlers = new QueryHandlers();
    this.campaignHooks = new CampaignHooks(this);
    this.consoleCapture = browserConsoleCapture;
    this.captureLifecycle = new ConsoleCaptureLifecycle(this.consoleCapture, {
      enabled: false,
      suspendWhileIdle: true,
      idleTimeoutMs: 120_000,
    });
    this.connectionRecovery = new ConnectionRecoveryController(() => this.recoverConnection());
  }

  /**
   * Check if current user is a GM (silent check for security)
   */
  private isGMUser(): boolean {
    return game.user?.isGM || false;
  }

  /**
   * Initialize the module during Foundry's init hook
   */
  async initialize(): Promise<void> {
    try {
      console.log(`[${MODULE_ID}] Initializing Foundry MCP Bridge...`);

      // Register module settings
      this.settings.registerSettings();

      // Expose console capture globally for settings callbacks and diagnostics
      (window as any).foundryMCPBridge.consoleCapture = this.consoleCapture;

      // Register query handlers
      this.queryHandlers.registerHandlers();

      // Register campaign hooks for interactive dashboards
      this.campaignHooks.register();

      // Expose data access globally for settings UI
      (window as any).foundryMCPBridge.dataAccess = this.queryHandlers.dataAccess;

      this.isInitialized = true;
      console.log(`[${MODULE_ID}] Module initialized successfully`);
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to initialize:`, error);
      ui.notifications.error('Failed to initialize Foundry MCP Bridge');
      throw error;
    }
  }

  /**
   * Start the module after Foundry is ready
   */
  async onReady(): Promise<void> {
    try {
      // SECURITY: Silent GM-only check - non-GM users get no access and no messages
      if (!this.isGMUser()) {
        console.log(`[${MODULE_ID}] Module ready (user access restricted)`);
        return;
      }

      console.log(`[${MODULE_ID}] Foundry ready, checking bridge status...`);

      try {
        const removedSettings = await this.settings.migrateRemovedFeatureState();
        if (removedSettings.length > 0) {
          console.log(
            `[${MODULE_ID}] Removed retired feature settings: ${removedSettings.join(', ')}`
          );
        }
      } catch (error) {
        // Cleanup must never prevent the bridge from connecting. An unfinished
        // migration remains at its prior version and is retried on the next load.
        console.warn(`[${MODULE_ID}] Retired feature settings cleanup will be retried:`, error);
      }

      this.connectionRecovery.start();

      this.refreshCapturePolicy();

      // Connection control now handled through settings menu

      // Validate settings
      const validation = this.settings.validateSettings();
      if (!validation.valid) {
        console.warn(`[${MODULE_ID}] Invalid settings:`, validation.errors);
        ui.notifications.warn(
          `MCP Bridge settings validation failed: ${validation.errors.join(', ')}`
        );
      }

      // Auto-connect when enabled (always automatic)
      const enabled = this.settings.getSetting('enabled');

      if (enabled) {
        await this.start();
      }

      console.log(`[${MODULE_ID}] Module ready`);
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed during ready:`, error);
    }
  }

  /**
   * Start the MCP bridge connection
   */
  async start(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Module not initialized');
    }

    // SECURITY: Double-check GM access (safety measure)
    if (!this.isGMUser()) {
      console.warn(`[${MODULE_ID}] Attempted to start bridge without GM access`);
      return;
    }

    if (this.isConnecting) {
      console.log(`[${MODULE_ID}] Bridge already connecting`);
      return;
    }

    if (this.socketBridge) {
      const state = this.socketBridge.getConnectionState();
      if (state !== CONNECTION_STATES.DISCONNECTED) {
        console.log(`[${MODULE_ID}] Bridge already running or reconnecting (${state})`);
        return;
      }

      // A fully disconnected transport cannot self-heal. Release it before
      // creating a replacement so only one reconnect owner can exist.
      this.socketBridge.disconnect();
      this.socketBridge = null;
    }

    const connectionGeneration = ++this.connectionGeneration;
    this.isConnecting = true;
    let socketBridge: SocketBridge | null = null;

    try {
      console.log(`[${MODULE_ID}] Starting MCP bridge...`);

      const config = this.settings.getBridgeConfig();

      // Validate configuration
      const validation = this.settings.validateSettings();
      if (!validation.valid) {
        throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
      }

      this.refreshCapturePolicy();

      // Create and connect one owned socket bridge. Lifecycle callbacks also
      // run after automatic reconnects, so capture/event state stays accurate.
      socketBridge = new SocketBridge(config, {
        onQueryStart: () => {
          if (!socketBridge || this.socketBridge !== socketBridge) return;
          const activityToken = this.captureLifecycle.beginTrackedActivity();
          this.updateLastActivity();
          return activityToken;
        },
        onQueryEnd: activityToken => {
          if (!socketBridge || this.socketBridge !== socketBridge) return;
          this.captureLifecycle.endTrackedActivity(
            activityToken as ConsoleCaptureActivityToken | null
          );
        },
        onConnected: () => {
          if (!socketBridge || this.socketBridge !== socketBridge) return;
          this.handleTransportConnected(socketBridge);
        },
        onDisconnected: () => {
          if (!socketBridge || this.socketBridge !== socketBridge) return;
          this.handleTransportDisconnected();
        },
      });
      this.socketBridge = socketBridge;
      this.startHeartbeat();
      await socketBridge.connect();

      if (
        this.connectionGeneration !== connectionGeneration ||
        this.socketBridge !== socketBridge ||
        this.settings.getSetting('enabled') !== true
      ) {
        socketBridge.disconnect();
        return;
      }

      // Log connection details for debugging
      const connectionInfo = socketBridge.getConnectionInfo();
      console.log(
        `[${MODULE_ID}] Bridge started successfully - Type: ${connectionInfo.type}, State: ${connectionInfo.state}`
      );

      // Show connection notification based on user preference
      if (this.settings.getSetting('enableNotifications')) {
        ui.notifications.info('🔗 MCP Bridge connected successfully');
      }
      console.log(
        `[${MODULE_ID}] GM connection established - Bridge active for user: ${game.user?.name}`
      );
    } catch (error) {
      if (
        this.connectionGeneration !== connectionGeneration ||
        (socketBridge !== null && this.socketBridge !== socketBridge)
      ) {
        return;
      }

      // Log as warning instead of error for initial connection failures
      console.warn(`[${MODULE_ID}] Failed to start bridge:`, error);

      // Show helpful message for GM users when MCP server isn't available
      if (this.isGMUser()) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if it's a connection refusal (MCP server not running)
        if (
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('connect ECONNREFUSED')
        ) {
          // Only show this notification if it's been more than 30 seconds since last shown
          const lastShown = this.settings.getSetting('lastMCPServerNotification') as string;
          const now = new Date().getTime();
          const thirtySecondsAgo = now - 30 * 1000;

          if (!lastShown || new Date(lastShown).getTime() < thirtySecondsAgo) {
            ui.notifications?.warn(
              'MCP Server not found. Install it from https://github.com/webmaster94/foundry-vtt-mcp'
            );

            // Remember when we showed this notification
            this.settings
              .setSetting('lastMCPServerNotification', new Date().toISOString())
              .catch(() => {
                // Ignore settings save errors during startup
              });
          }
        }
      }

      await this.settings.setSetting('lastConnectionState', 'error');
      throw error;
    } finally {
      if (this.connectionGeneration === connectionGeneration) {
        this.isConnecting = false;
      }
    }
  }

  /**
   * Stop the MCP bridge connection
   */
  async stop(): Promise<void> {
    this.connectionGeneration += 1;
    this.isConnecting = false;
    const socketBridge = this.socketBridge;
    const wasRunning = socketBridge !== null || this.captureLifecycle.getStatus().bridgeRunning;
    try {
      this.socketBridge = null;
      this.handleTransportDisconnected();
      this.stopHeartbeat();
      socketBridge?.disconnect();

      if (!wasRunning) {
        console.log(`[${MODULE_ID}] Bridge already stopped`);
        return;
      }

      console.log(`[${MODULE_ID}] Stopping MCP bridge...`);

      await this.settings.setSetting('lastConnectionState', 'disconnected');

      console.log(`[${MODULE_ID}] Bridge stopped`);

      // Show disconnection notification based on user preference
      if (this.settings.getSetting('enableNotifications')) {
        ui.notifications.info('MCP Bridge disconnected');
      }
    } catch (error) {
      console.error(`[${MODULE_ID}] Error stopping bridge:`, error);
    }
  }

  /**
   * Restart the bridge with current settings
   */
  async restart(): Promise<void> {
    console.log(`[${MODULE_ID}] Restarting bridge...`);

    await this.stop();

    // Small delay to ensure clean disconnect
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (this.settings.getSetting('enabled')) {
      await this.start();
    }
  }

  /** Keep a passive GM retry owner current without replacing its bridge. */
  refreshStandbyConfiguration(): void {
    if (!this.socketBridge?.getConnectionInfo().standbyBecauseOwnerActive) return;
    this.socketBridge.updateConfig(this.settings.getBridgeConfig());
    this.startHeartbeat();
  }

  /** Wake the current reconnect owner after a tab or network resumes. */
  private async recoverConnection(): Promise<void> {
    if (!this.isInitialized || !this.isGMUser() || this.settings.getSetting('enabled') !== true) {
      return;
    }

    if (this.socketBridge) {
      await this.socketBridge.reconnectNow();
      return;
    }

    await this.start();
  }

  /** Re-read capture settings and apply them without restarting the bridge. */
  refreshCapturePolicy(): void {
    try {
      this.consoleCapture.configureFromSettings();
      const timeoutSeconds = Number(this.settings.getSetting('consoleCaptureIdleTimeout'));
      const idleTimeoutMs = Number.isFinite(timeoutSeconds)
        ? Math.min(Math.max(timeoutSeconds * 1000, 30_000), 900_000)
        : 120_000;
      this.captureLifecycle.refreshPolicy({
        enabled: this.settings.getSetting('enableConsoleCapture') === true,
        suspendWhileIdle: this.settings.getSetting('suspendConsoleCaptureWhileIdle') === true,
        idleTimeoutMs,
      });
    } catch (error) {
      // Settings may still be registering during Foundry's init phase.
      console.warn(`[${MODULE_ID}] Could not refresh console capture policy:`, error);
    }
  }

  getConsoleCaptureStatus(): any {
    return {
      ...this.consoleCapture.getStatus(),
      lifecycle: this.captureLifecycle.getStatus(),
    };
  }

  private handleTransportConnected(socketBridge: SocketBridge): void {
    this.captureLifecycle.start();
    eventService.registerHooks();
    eventService.setSender(event => socketBridge.sendEvent(event));
    this.settings.updateConnectionStatusDisplay(true, 0);
    void this.settings.setSetting('lastConnectionState', 'connected');
    this.updateLastActivity(true);
  }

  private handleTransportDisconnected(): void {
    this.captureLifecycle.stop();
    eventService.setSender(null);
    eventService.unregisterHooks();
    this.settings.updateConnectionStatusDisplay(false, 0);
  }

  /**
   * Get current bridge status
   */
  getStatus(): any {
    return {
      initialized: this.isInitialized,
      enabled: this.settings.getSetting('enabled'),
      connected: this.socketBridge?.isConnected() ?? false,
      connectionState: this.socketBridge?.getConnectionState() ?? 'disconnected',
      connectionInfo: this.socketBridge?.getConnectionInfo(),
      settings: this.settings.getAllSettings(),
      registeredMethods: this.queryHandlers.getRegisteredMethods(),
      consoleCapture: this.consoleCapture.getStatus(),
      consoleCaptureLifecycle: this.captureLifecycle.getStatus(),
      lastConnectionState: this.settings.getSetting('lastConnectionState'),
      lastActivity: this.lastActivity.toISOString(),
      heartbeatActive: this.heartbeatInterval !== null,
    };
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    this.stopHeartbeat(); // Ensure no duplicate intervals

    const interval = this.settings.getSetting('heartbeatInterval') * 1000; // Convert to milliseconds

    this.heartbeatInterval = window.setInterval(async () => {
      await this.performHeartbeat();
    }, interval);

    console.log(`[${MODULE_ID}] Heartbeat monitoring started (${interval}ms interval)`);
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log(`[${MODULE_ID}] Heartbeat monitoring stopped`);
    }
  }

  /**
   * Perform heartbeat check
   */
  private async performHeartbeat(): Promise<void> {
    try {
      // The persistent Node daemon owns authoritative network liveness. This
      // browser timer is only a fallback wake-up for delayed/throttled retry
      // timers and never replaces or disables the existing reconnect owner.
      if (this.socketBridge && !this.socketBridge.isConnected()) {
        await this.socketBridge.reconnectNow();
      }
    } catch (error) {
      console.warn(
        `[${MODULE_ID}] Fallback connection wake-up failed; retry loop remains active:`,
        error
      );
    }
  }

  /**
   * Update last activity timestamp
   */
  updateLastActivity(persist = false): void {
    this.lastActivity = new Date();
    if (persist) {
      void this.settings.setSetting('lastActivity', this.lastActivity.toISOString());
    }
  }

  /**
   * Get query handlers for campaign hooks
   */
  getQueryHandlers(): QueryHandlers {
    return this.queryHandlers;
  }

  /**
   * Connection control is now handled through the settings menu
   */

  /**
   * Cleanup when module is disabled or world is closed
   */
  async cleanup(): Promise<void> {
    console.log(`[${MODULE_ID}] Cleaning up...`);

    this.connectionRecovery.stop();
    await this.stop();
    this.captureLifecycle.shutdown();
    this.queryHandlers.unregisterHandlers();
    this.campaignHooks.unregister();

    console.log(`[${MODULE_ID}] Cleanup complete`);
  }
}

// Create global instance
const foundryMCPBridge = new FoundryMCPBridge();

// Make it available globally for settings callbacks
(window as any).foundryMCPBridge = foundryMCPBridge;

// Foundry VTT Hooks
Hooks.once('init', async () => {
  try {
    await foundryMCPBridge.initialize();
  } catch (error) {
    console.error(`[${MODULE_ID}] Initialization failed:`, error);
  }
});

Hooks.once('ready', async () => {
  try {
    await foundryMCPBridge.onReady();

    // Register socket listener for roll state management (after game.user is available)

    game.socket?.on('module.foundry-mcp-bridge', async data => {
      try {
        // Handle ChatMessage update requests (GM only)
        if (data.type === 'requestMessageUpdate' && data.buttonId && data.messageId) {
          // Only GM can update ChatMessages for other users
          if (game.user?.isGM) {
            try {
              // Get the data access instance to update the message
              const queryHandlers = foundryMCPBridge['queryHandlers'] as any;
              if (queryHandlers && queryHandlers.dataAccess) {
                await queryHandlers.dataAccess.updateRollButtonMessage(
                  data.buttonId,
                  data.userId,
                  data.rollLabel
                );
              }
            } catch (error) {
              console.error(`[${MODULE_ID}] GM failed to update message:`, error);
              // Notify GM about the failure
              if (game.user?.isGM) {
                ui.notifications?.error(
                  `Failed to update player roll message: ${error instanceof Error ? error.message : 'Unknown error'}`
                );
              }
            }
          } else {
          }
          return;
        }

        // Handle roll state save requests (GM only) - LEGACY
        if (data.type === 'requestRollStateSave' && data.buttonId && data.rollState) {
          // Only GM can save to world settings
          if (game.user?.isGM) {
            try {
              // Get the data access instance to save the roll state
              const queryHandlers = foundryMCPBridge['queryHandlers'] as any;
              if (queryHandlers && queryHandlers.dataAccess) {
                await queryHandlers.dataAccess.saveRollState(
                  data.buttonId,
                  data.rollState.rolledBy
                );
              }
            } catch (error) {
              console.error(`[${MODULE_ID}] GM failed to save LEGACY roll state:`, error);
              // Notify GM about the failure so they can take action
              if (game.user?.isGM) {
                ui.notifications?.error(
                  `Failed to save player roll state: ${error instanceof Error ? error.message : 'Unknown error'}`
                );
              }
            }
          } else {
          }
          return;
        }

        // Handle real-time roll state updates - LEGACY (now handled by ChatMessage.update())
        if (data.type === 'rollStateUpdate' && data.buttonId && data.rollState) {
          // No longer needed - ChatMessage.update() automatically syncs across all clients
        }

        // Note: rollStateSaved confirmations removed - not needed since rollStateUpdate handles UI sync
      } catch (error) {
        console.error(`[${MODULE_ID}] Error handling socket message:`, error);
      }
    });
  } catch (error) {
    console.error(`[${MODULE_ID}] Ready failed:`, error);
  }
});

// Handle settings menu close to check for changes
Hooks.on('closeSettingsConfig', () => {
  try {
    const enabled = foundryMCPBridge.getStatus().enabled;
    const connected = foundryMCPBridge.getStatus().connected;

    if (enabled && !connected) {
      // Setting was enabled but not connected, try to start
      foundryMCPBridge.start().catch(error => {
        console.error(`[${MODULE_ID}] Failed to start after settings change:`, error);
      });
    } else if (!enabled && connected) {
      // Setting was disabled but still connected, stop
      foundryMCPBridge.stop().catch(error => {
        console.error(`[${MODULE_ID}] Failed to stop after settings change:`, error);
      });
    }
  } catch (error) {
    console.error(`[${MODULE_ID}] Error handling settings change:`, error);
  }
});

// Global hook to handle MCP roll button rendering and state management
// Using renderChatMessageHTML for Foundry v13 compatibility (renderChatMessage is deprecated)
Hooks.on('renderChatMessageHTML', (message: any, html: HTMLElement) => {
  try {
    // Convert HTMLElement to jQuery for compatibility with existing handler code
    const $html = $(html);

    // Check if this message has MCP roll button flags
    const rollButtons = message.getFlag?.(MODULE_ID, 'rollButtons');

    if (rollButtons) {
      // Get the data access instance
      const queryHandlers = foundryMCPBridge['queryHandlers'] as any;
      if (queryHandlers && queryHandlers.dataAccess) {
        // Check if any buttons in this message are already rolled
        for (const [_buttonId, buttonData] of Object.entries(rollButtons as any)) {
          if (buttonData && typeof buttonData === 'object' && (buttonData as any).rolled) {
            break;
          }
        }

        // If message has rolled buttons, the content should already be updated
        // Just attach any necessary handlers for active buttons
        if ($html.find('.mcp-roll-button').length > 0) {
          // Only attach handlers to active (non-rolled) buttons
          queryHandlers.dataAccess.attachRollButtonHandlers($html);
        }
      }
    } else if ($html.find('.mcp-roll-button').length > 0) {
      // Legacy message without flags - fall back to old behavior

      const queryHandlers = foundryMCPBridge['queryHandlers'] as any;
      if (queryHandlers && queryHandlers.dataAccess) {
        queryHandlers.dataAccess.attachRollButtonHandlers($html);

        // Check for legacy roll states
        setTimeout(() => {
          queryHandlers.dataAccess.ensureButtonStatesForMessage($html);
        }, 100);
      }
    }
  } catch (error) {
    console.warn(`[${MODULE_ID}] Error processing roll buttons in chat message:`, error);
  }
});

// Socket listener will be registered in the 'ready' hook when game.user is available

// Handle world close/reload
Hooks.on('canvasReady', () => {
  // Canvas ready indicates the world is fully loaded
  // Good time to ensure bridge is in correct state
  try {
    const status = foundryMCPBridge.getStatus();
    if (status.enabled && !status.connected) {
      foundryMCPBridge.start().catch(error => {
        console.warn(`[${MODULE_ID}] Failed to reconnect on canvas ready:`, error);
      });
    }
  } catch (error) {
    console.error(`[${MODULE_ID}] Error on canvas ready:`, error);
  }
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  foundryMCPBridge.cleanup().catch(error => {
    console.error(`[${MODULE_ID}] Cleanup failed:`, error);
  });
});

// Development helpers (only in debug mode)
if (typeof window !== 'undefined') {
  (window as any).foundryMCPDebug = {
    bridge: foundryMCPBridge,
    getStatus: () => foundryMCPBridge.getStatus(),
    start: () => foundryMCPBridge.start(),
    stop: () => foundryMCPBridge.stop(),
    restart: () => foundryMCPBridge.restart(),
  };
}

export { foundryMCPBridge };
