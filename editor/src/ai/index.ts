/**
 * The AI panel feature: registers the trailing panel with the reserved id AI_PANEL_ID ('ai'), which
 * turns on the sparkles button of the toolbar. Imported once by shell/extensions.ts.
 *
 * Other modules use ./api.ts (openAiPanel, startAiTask, useAiJob, aiAvailability).
 */
import { t } from '../i18n/index.js';
import { AI_PANEL_ID, registerPanel } from '../shell/registry.js';
import { AiPanel } from './AiPanel.js';

registerPanel({ id: AI_PANEL_ID, title: () => t('ai.title'), icon: 'sparkles', order: 0, render: AiPanel });
