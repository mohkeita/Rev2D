/**
 * The few words the components say by themselves (accessible names of built-in buttons, default
 * placeholders). English by default; an application with its own languages replaces them with
 * `setDesignStrings` whenever its language changes (components read them when they render).
 */
export interface DesignStrings {
  /** Clear button of a text field. */
  clear: string;
  /** Close button of a toast, grabber of a sheet. */
  dismiss: string;
  /** Disclosure triangle of a tree row. */
  expand: string;
  collapse: string;
  /** Default placeholder of a search field. */
  search: string;
  /** Default placeholder of a select without a value. */
  select: string;
  /** Accessible name of a spinner. */
  inProgress: string;
  /** Tooltip of the scrub handle of a number field. */
  dragToChange: string;
  /** Accessible name of the toast region. */
  notifications: string;
  /** Accessible name of a split-view divider, given the name of its pane. */
  resize: (pane: string) => string;
}

const DEFAULTS: DesignStrings = {
  clear: 'Clear',
  dismiss: 'Dismiss',
  expand: 'Expand',
  collapse: 'Collapse',
  search: 'Search',
  select: 'Select',
  inProgress: 'In progress',
  dragToChange: 'Drag to change',
  notifications: 'Notifications',
  resize: (pane) => `Resize ${pane}`,
};

/** The strings in effect. Read at render time: `designStrings.clear`. */
export const designStrings: DesignStrings = { ...DEFAULTS };

/** Replace some (or, without an argument, restore all) of the built-in strings. */
export function setDesignStrings(strings?: Partial<DesignStrings>): void {
  Object.assign(designStrings, DEFAULTS, strings);
}
