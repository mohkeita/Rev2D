/**
 * Rev2D design system: tokens, base styles, components and icons. Import everything from here:
 *
 *   import { Button, Slider, Icon, useAppearance } from './design/index.js';
 *
 * Importing this module loads tokens.css and base.css (once) and the stylesheet of every component.
 * Put `class="r2-app"` on the application root. See README.md in this folder and
 * docs/DESIGN-SYSTEM.md.
 */
import './tokens.css';
import './base.css';

export { Icon, ICON_NAMES, iconStrokeWidth, isIconName, type IconName, type IconProps } from './icons.js';
export { applyAppearance, parseComputedColor, readColorToken, readStoredAppearance, storeAppearance, useAppearance, APPEARANCE_STORAGE_KEY } from './appearance.js';
export { APPEARANCES, nextAppearance, parseAppearance, resolveAppearance, type Appearance } from './logic/appearance.js';

export { Layer, Floating, anchorRect, type Anchor, type FloatingProps, type LayerProps } from './components/Layer.js';
export { ProgressView, Spinner, type ProgressViewProps } from './components/ProgressView.js';
export { Tooltip, type TooltipProps } from './components/Tooltip.js';
export { Button, IconButton, type ButtonProps, type ButtonVariant, type ControlSize, type IconButtonProps } from './components/Button.js';
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from './components/SegmentedControl.js';
export { Switch, type SwitchProps } from './components/Switch.js';
export { Slider, type SliderProps } from './components/Slider.js';
export { Stepper, type StepperProps } from './components/Stepper.js';
export { TextField, SearchField, NumberField, type NumberFieldProps, type SearchFieldProps, type TextFieldProps } from './components/TextField.js';
export { Menu, ContextMenu, MenuList, type ContextMenuProps, type MenuEntry, type MenuItem, type MenuListProps, type MenuProps } from './components/Menu.js';
export { Select, type SelectOption, type SelectProps } from './components/Select.js';
export { Popover, type PopoverProps } from './components/Popover.js';
export { Sheet, Alert, type AlertAction, type AlertProps, type SheetProps } from './components/Sheet.js';
export { Toast, ToastProvider, useToast, type ToastApi, type ToastOptions, type ToastProps, type ToastProviderProps } from './components/Toast.js';
export { Badge, type BadgeProps, type BadgeTone } from './components/Badge.js';
export { Tabs, tabPanelProps, type TabItem, type TabsProps } from './components/Tabs.js';
export { List, ListRow, ListSection, type ListProps, type ListRowProps, type ListSectionProps } from './components/List.js';
export { Sidebar, Inspector, Drawer, InspectorRow, InspectorSection, type InspectorRowProps, type InspectorSectionProps, type PanelProps } from './components/Panel.js';
export { Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarSpacer, ToolbarTitle, type ToolbarGroupProps, type ToolbarProps, type ToolbarTitleProps } from './components/Toolbar.js';
export { SplitView, type SplitPane, type SplitViewProps } from './components/SplitView.js';
export { EmptyState, Checkerboard, type CheckerboardProps, type EmptyStateProps } from './components/EmptyState.js';
export { useFocusScope, type FocusScopeOptions } from './components/focus.js';

export type { DockEdge, DockLayout, DockPaneLayout, DockPaneSpec, DockState, Insets } from './logic/dock.js';
export { initialDockState, layoutDock, toggleDock } from './logic/dock.js';
export { designStrings, setDesignStrings, type DesignStrings } from './strings.js';
export type { Placement } from './logic/position.js';
export type { ToastTone } from './logic/toast.js';
