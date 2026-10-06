/**
 * The features of this editor build: each module registers itself with the shell when it is
 * imported (a workspace mode, a trailing panel, toolbar actions; see registry.ts and README.md).
 * Adding a feature is one import line here; App.tsx and Shell.tsx stay as they are.
 */
import './rigMode.js';
import '../ai/index.js';
import '../avatar/avatarMode.js';
