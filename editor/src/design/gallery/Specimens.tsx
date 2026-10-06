/** Gallery page "Components": every component of the design system in its states. */
import { useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkerboard,
  ContextMenu,
  EmptyState,
  IconButton,
  Inspector,
  InspectorRow,
  InspectorSection,
  List,
  ListRow,
  ListSection,
  Menu,
  NumberField,
  Popover,
  ProgressView,
  SearchField,
  SegmentedControl,
  Select,
  Sheet,
  Sidebar,
  Slider,
  Spinner,
  SplitView,
  Stepper,
  Switch,
  Tabs,
  TextField,
  Toast,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarSpacer,
  ToolbarTitle,
  Tooltip,
  useToast,
  type MenuEntry,
} from '../index.js';

export function Specimen({ id, title, note, wide, children }: { id: string; title: string; note?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className="g-specimen" id={id} data-wide={wide ? '' : undefined} data-testid={`specimen-${id}`}>
      <header className="g-specimen-head">
        <h3 className="g-specimen-title">{title}</h3>
        {note != null && <p className="g-specimen-note">{note}</p>}
      </header>
      <div className="g-specimen-body">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="g-row">
      {label && <span className="g-row-label">{label}</span>}
      <div className="g-row-items">{children}</div>
    </div>
  );
}

const MENU: MenuEntry[] = [
  { type: 'label', label: 'Part' },
  { id: 'rename', label: 'Rename', icon: 'pencil', shortcut: 'F2' },
  { id: 'duplicate', label: 'Duplicate', icon: 'copy', shortcut: 'Ctrl+D' },
  { id: 'mask', label: 'Use as Mask', icon: 'mask', checked: true },
  { id: 'lock', label: 'Lock', icon: 'lock', checked: false },
  { type: 'separator' },
  { id: 'export', label: 'Export Layer…', icon: 'export', disabled: true },
  { id: 'delete', label: 'Delete', icon: 'trash', destructive: true, shortcut: 'Del' },
];

export function Specimens() {
  const toast = useToast();
  const [segment, setSegment] = useState('parts');
  const [view, setView] = useState('grid');
  const [wifi, setWifi] = useState(true);
  const [angle, setAngle] = useState(12);
  const [opacity, setOpacity] = useState(0.6);
  const [steps, setSteps] = useState(3);
  const [count, setCount] = useState(2);
  const [name, setName] = useState('hana');
  const [query, setQuery] = useState('');
  const [x, setX] = useState(256);
  const [rotation, setRotation] = useState(-12.5);
  const [blend, setBlend] = useState('normal');
  const [language, setLanguage] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState<null | 'sheet' | 'dialog' | 'alert'>(null);
  const [tab, setTab] = useState('timeline');
  const [selected, setSelected] = useState('face');
  const [lastAction, setLastAction] = useState('none');
  const [physics, setPhysics] = useState(true);

  return (
    <div className="g-grid">
      <Specimen id="buttons" title="Button" note="Filled marks the one primary action of a view; tinted, gray and plain step down from it. Small and medium buttons are rounded rectangles, large ones capsules.">
        <Row label="Styles">
          <Button variant="filled" data-testid="button-filled">
            Create
          </Button>
          <Button variant="tinted">Duplicate</Button>
          <Button variant="gray">Cancel</Button>
          <Button variant="plain">Learn More</Button>
        </Row>
        <Row label="Destructive">
          <Button variant="filled" destructive>
            Delete
          </Button>
          <Button variant="tinted" destructive>
            Delete
          </Button>
          <Button variant="gray" destructive>
            Discard
          </Button>
          <Button variant="plain" destructive>
            Remove
          </Button>
        </Row>
        <Row label="Sizes">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button size="xl" variant="filled">
            Extra Large
          </Button>
        </Row>
        <Row label="Icons, states">
          <Button icon="plus">Add Part</Button>
          <Button variant="tinted" icon="sparkles">
            Generate
          </Button>
          <Button variant="filled" loading>
            Exporting…
          </Button>
          <Button disabled>Disabled</Button>
          <Button variant="filled" shape="capsule" trailingIcon="chevronRight">
            Continue
          </Button>
        </Row>
      </Specimen>

      <Specimen id="icon-buttons" title="IconButton" note="Always has a label (the tooltip and the accessible name). Toggles show the tint when on.">
        <Row label="Styles">
          <IconButton icon="plus" label="Add" />
          <IconButton icon="sliders" label="Adjust" variant="gray" />
          <IconButton icon="sparkles" label="Generate" variant="tinted" />
          <IconButton icon="check" label="Done" variant="filled" />
          <IconButton icon="trash" label="Delete" destructive />
        </Row>
        <Row label="Sizes">
          <IconButton icon="eye" label="Show" size="sm" variant="gray" />
          <IconButton icon="eye" label="Show" size="md" variant="gray" />
          <IconButton icon="eye" label="Show" size="lg" variant="gray" />
          <IconButton icon="eye" label="Show" size="xl" variant="gray" />
          <IconButton icon="grid" label="Grid" shape="rounded" variant="gray" />
        </Row>
        <Row label="Toggle">
          <IconButton icon="bone" label="Bones" pressed />
          <IconButton icon="mesh" label="Mesh" pressed={false} />
          <IconButton icon="lock" label="Lock" pressed variant="gray" />
          <IconButton icon="redo" label="Redo" disabled />
        </Row>
      </Specimen>

      <Specimen id="segmented" title="SegmentedControl" note="Two to seven closely related choices, equally wide. Arrow keys move the selection.">
        <Row>
          <SegmentedControl
            aria-label="Outline"
            data-testid="segmented"
            value={segment}
            onChange={setSegment}
            options={[
              { value: 'parts', label: 'Parts' },
              { value: 'bones', label: 'Bones' },
              { value: 'params', label: 'Parameters' },
            ]}
          />
        </Row>
        <Row>
          <SegmentedControl
            aria-label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', icon: 'menu', ariaLabel: 'List' },
              { value: 'grid', icon: 'grid', ariaLabel: 'Grid' },
              { value: 'layers', icon: 'layers', ariaLabel: 'Layers' },
            ]}
          />
          <SegmentedControl
            aria-label="Size"
            size="sm"
            shape="rounded"
            defaultValue="m"
            options={[
              { value: 's', label: 'S' },
              { value: 'm', label: 'M' },
              { value: 'l', label: 'L' },
              { value: 'xl', label: 'XL', disabled: true },
            ]}
          />
        </Row>
        <Row>
          <SegmentedControl
            block
            size="lg"
            aria-label="Appearance"
            defaultValue="auto"
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
      </Specimen>

      <Specimen id="switch" title="Switch" note="An on / off setting that applies immediately. In a row, the row title is its label.">
        <Row>
          <Switch aria-label="Physics" data-testid="switch" checked={wifi} onChange={setWifi} />
          <Switch aria-label="Small" size="sm" defaultChecked />
          <Switch aria-label="Off" />
          <Switch aria-label="Disabled" disabled defaultChecked />
        </Row>
        <Row>
          <Switch label="Loop playback" defaultChecked />
        </Row>
      </Specimen>

      <Specimen id="slider" title="Slider" note="Drag the knob or the track. Arrow keys step, Shift steps by ten, double-click resets. The fill can start at a neutral value.">
        <Row label={`Angle X  ${angle}°`}>
          <Slider aria-label="Angle X" data-testid="slider" min={-30} max={30} step={1} origin={0} resetValue={0} ticks={[-30, -15, 0, 15, 30]} value={angle} onChange={setAngle} formatValue={(v) => `${v}°`} />
        </Row>
        <Row label={`Opacity  ${Math.round(opacity * 100)}%`}>
          <Slider aria-label="Opacity" min={0} max={1} step={0.01} value={opacity} onChange={setOpacity} formatValue={(v) => `${Math.round(v * 100)}%`} showValue="always" />
        </Row>
        <Row label={`Steps  ${steps}`}>
          <Slider aria-label="Steps" size="sm" min={0} max={5} step={1} ticks value={steps} onChange={setSteps} />
        </Row>
        <Row label="Disabled">
          <Slider aria-label="Disabled" disabled defaultValue={0.3} />
        </Row>
      </Specimen>

      <Specimen id="fields" title="TextField, SearchField, NumberField" note="Filled fields without borders; the focus ring is the tint. Number fields step with the arrow keys and scrub by dragging their prefix.">
        <Row>
          <TextField label="Name" value={name} onChange={setName} hint="Letters, digits and dashes." clearable />
        </Row>
        <Row>
          <TextField label="File" defaultValue="models/hana?.json" error="A file name cannot contain “?”." icon="document" />
        </Row>
        <Row>
          <SearchField value={query} onChange={setQuery} placeholder="Search parts" data-testid="search" />
        </Row>
        <Row>
          <NumberField aria-label="X" prefix="X" unit="px" width={104} value={x} onChange={setX} />
          <NumberField aria-label="Rotation" prefix="R" unit="°" width={104} step={0.5} value={rotation} onChange={setRotation} data-testid="number" />
          <Stepper value={count} onChange={setCount} min={0} max={5} decrementLabel="Fewer" incrementLabel="More" data-testid="stepper" />
          <span className="g-value r2-num">{count}</span>
        </Row>
      </Specimen>

      <Specimen id="menus" title="Select, Menu, ContextMenu" note="Menus grow out of the control that opened them. One level, verbs in title case, icons for a whole group or for none.">
        <Row>
          <Select
            aria-label="Blend mode"
            data-testid="select"
            value={blend}
            onChange={setBlend}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'add', label: 'Add' },
              { value: 'multiply', label: 'Multiply' },
              { value: 'screen', label: 'Screen' },
            ]}
          />
          <Select
            aria-label="Language"
            placeholder="Language"
            value={language}
            onChange={setLanguage}
            options={[
              { value: 'en', label: 'English', icon: 'globe' },
              { value: 'ko', label: '한국어', icon: 'globe' },
              { value: 'ja', label: '日本語', icon: 'globe' },
            ]}
          />
          <Menu items={MENU} aria-label="Part actions" onAction={setLastAction}>
            <Button trailingIcon="chevronDown" data-testid="menu-button">
              Actions
            </Button>
          </Menu>
          <Menu items={MENU} aria-label="More" placement="bottom-end" onAction={setLastAction}>
            <IconButton icon="more" label="More" variant="gray" />
          </Menu>
        </Row>
        <Row>
          <ContextMenu items={MENU} aria-label="Part actions" onAction={setLastAction}>
            <div className="g-context" tabIndex={0} data-testid="context-target">
              Right-click here (or focus and press Shift+F10)
            </div>
          </ContextMenu>
        </Row>
        <Row>
          <span className="g-caption" data-testid="menu-result">
            Last action: {lastAction}
          </span>
        </Row>
      </Specimen>

      <Specimen id="overlays" title="Popover, Sheet, Alert, Toast, Tooltip" note="A popover belongs to its control; a sheet is one scoped task; an alert asks one question; a toast reports and leaves.">
        <Row>
          <Popover
            title="Overlays"
            width={260}
            trigger={
              <Button icon="layers" data-testid="popover-button">
                Popover
              </Button>
            }
          >
            <List variant="inset">
              <ListSection>
                <ListRow title="Bones" icon="bone" trailing={(id) => <Switch aria-labelledby={id} size="sm" defaultChecked />} />
                <ListRow title="Mesh" icon="mesh" trailing={(id) => <Switch aria-labelledby={id} size="sm" />} />
                <ListRow title="Grid" icon="grid" trailing={(id) => <Switch aria-labelledby={id} size="sm" />} />
              </ListSection>
            </List>
          </Popover>
          <Button onClick={() => setSheet('sheet')} data-testid="sheet-button">
            Sheet
          </Button>
          <Button onClick={() => setSheet('dialog')} data-testid="dialog-button">
            Dialog
          </Button>
          <Button onClick={() => setSheet('alert')} data-testid="alert-button">
            Alert
          </Button>
        </Row>
        <Row>
          <Button onClick={() => toast.show({ title: 'Saved hana.r2d.json', tone: 'success' })} data-testid="toast-button">
            Toast
          </Button>
          <Button onClick={() => toast.show({ title: 'Part deleted', action: { label: 'Undo', onSelect: () => toast.show({ title: 'Restored' }) } })}>Toast with Undo</Button>
          <Button onClick={() => toast.show({ title: 'Could not load koi-atlas.png', description: 'The file is missing next to the model.', tone: 'danger' })}>Error Toast</Button>
          <Tooltip label="Fit the model in view" shortcut="F">
            <Button icon="fit">Hover or Focus</Button>
          </Tooltip>
        </Row>
        <Row>
          <Toast title="Exported 3 animations" tone="success" />
          <Toast title="2 warnings" description="A nested warp sticks out of its parent." tone="warning" action={{ label: 'Show', onSelect: () => {} }} />
        </Row>

        <Sheet
          open={sheet === 'sheet'}
          onClose={() => setSheet(null)}
          onConfirm={() => setSheet(null)}
          title="Export"
          data-testid="sheet"
          leading={
            <Button variant="plain" size="lg" onClick={() => setSheet(null)} data-testid="sheet-cancel">
              Cancel
            </Button>
          }
          trailing={
            <Button variant="filled" size="lg" onClick={() => setSheet(null)} data-testid="sheet-done">
              Export
            </Button>
          }
        >
          <div className="g-stack">
            <TextField label="Folder" defaultValue="exports/hana-spine" icon="folder" data-testid="sheet-field" />
            <List variant="inset">
              <ListSection header="Include" footer="Spine exports are baked: parameters, warps and physics end up in the animations.">
                <ListRow title="Animations" trailing={<span>idle, talk, wave</span>} disclosure onSelect={() => {}} />
                <ListRow title="Parameter Poses" trailing={(id) => <Switch aria-labelledby={id} defaultChecked />} />
                <ListRow title="Texture Scale" trailing={<Stepper defaultValue={2} min={1} max={4} size="sm" />} />
              </ListSection>
            </List>
          </div>
        </Sheet>

        <Sheet
          open={sheet === 'dialog'}
          presentation="dialog"
          size="sm"
          onClose={() => setSheet(null)}
          onConfirm={() => setSheet(null)}
          title="Rename Part"
          data-testid="dialog"
          actions={
            <>
              <Button size="lg" onClick={() => setSheet(null)}>
                Cancel
              </Button>
              <Button size="lg" variant="filled" onClick={() => setSheet(null)}>
                Rename
              </Button>
            </>
          }
        >
          <TextField label="Id" defaultValue="hairFront" hint="References in bindings and animations are updated." data-autofocus="" />
        </Sheet>

        <Alert
          open={sheet === 'alert'}
          data-testid="alert"
          title="Delete “hairFront”?"
          message="Its 3 bindings and 12 keyframes are deleted with it. You can undo this."
          onClose={() => setSheet(null)}
          actions={[
            { label: 'Cancel', role: 'cancel' },
            { label: 'Delete', role: 'destructive', onSelect: () => toast.show({ title: 'Part deleted' }) },
          ]}
        />
      </Specimen>

      <Specimen id="sheets" title="Sheet presentations" wide note="The three presentations, shown in place (modal={false}): a sheet rises from the bottom edge with a grabber, a dialog is a centred card, an alert asks one question. Cancel leads, the confirming action trails.">
        <div className="g-sheet-frames">
          <div className="g-sheet-frame">
            <Sheet
              open
              modal={false}
              onClose={() => {}}
              title="Export"
              leading={
                <Button variant="plain" size="lg" tabIndex={-1}>
                  Cancel
                </Button>
              }
              trailing={
                <Button variant="filled" size="lg" tabIndex={-1}>
                  Export
                </Button>
              }
            >
              <List variant="inset">
                <ListSection>
                  <ListRow title="Format" trailing={<span>Spine 4.2</span>} disclosure />
                  <ListRow title="Parameter Poses" trailing={(id) => <Switch aria-labelledby={id} defaultChecked tabIndex={-1} />} />
                </ListSection>
              </List>
            </Sheet>
          </div>
          <div className="g-sheet-frame">
            <Sheet
              open
              modal={false}
              presentation="dialog"
              size="sm"
              onClose={() => {}}
              title="Rename Part"
              actions={
                <>
                  <Button size="lg" tabIndex={-1}>
                    Cancel
                  </Button>
                  <Button size="lg" variant="filled" tabIndex={-1}>
                    Rename
                  </Button>
                </>
              }
            >
              <TextField label="Id" defaultValue="hairFront" hint="References are updated." tabIndex={-1} />
            </Sheet>
          </div>
          <div className="g-sheet-frame">
            <Sheet
              open
              modal={false}
              presentation="alert"
              onClose={() => {}}
              title="Discard Changes?"
              description="Your edits to hana.r2d.json since the last save will be lost."
              actions={
                <>
                  <Button size="lg" block tabIndex={-1}>
                    Cancel
                  </Button>
                  <Button size="lg" block destructive tabIndex={-1}>
                    Discard
                  </Button>
                </>
              }
            />
          </div>
        </div>
      </Specimen>

      <Specimen id="progress" title="ProgressView, Badge" note="Determinate whenever the amount of work is known. Badges always carry text or sit next to a label.">
        <Row label="Linear">
          <ProgressView value={0.62} aria-label="Export" label="Rendering frame 37 of 60" />
        </Row>
        <Row label="Indeterminate">
          <ProgressView aria-label="Working" />
        </Row>
        <Row label="Circular">
          <ProgressView variant="circular" value={0.25} aria-label="25%" />
          <ProgressView variant="circular" value={0.7} size={28} aria-label="70%" />
          <Spinner />
          <Spinner size={24} />
        </Row>
        <Row label="Badges">
          <Badge>12</Badge>
          <Badge tone="tint">New</Badge>
          <Badge tone="success" icon="check">
            Valid
          </Badge>
          <Badge tone="warning" icon="warning">
            2 Warnings
          </Badge>
          <Badge tone="danger">Error</Badge>
          <Badge tone="danger" variant="solid">
            3
          </Badge>
          <Badge variant="outline">30 fps</Badge>
          <Badge tone="success" dot aria-label="Connected" />
        </Row>
      </Specimen>

      <Specimen id="tabs" title="Tabs" note="Views that share one area. The selected tab sits on a soft capsule.">
        <Tabs
          aria-label="Dock"
          data-testid="tabs"
          value={tab}
          onChange={setTab}
          trailing={<IconButton icon="chevronDown" label="Hide" size="sm" />}
          tabs={[
            { id: 'timeline', label: 'Timeline', icon: 'timeline' },
            { id: 'parameters', label: 'Parameters', icon: 'sliders' },
            { id: 'issues', label: 'Issues', icon: 'warning', badge: <Badge tone="warning">2</Badge> },
            { id: 'log', label: 'Log', disabled: true },
          ]}
        >
          {(id) => <div className="g-tab-panel">The {id} panel.</div>}
        </Tabs>
      </Specimen>

      <Specimen id="list" title="List" note="Inset grouped rows: icon, title, subtitle, trailing accessory, disclosure. Separators start at the text.">
        <List variant="inset" aria-label="Settings">
          <ListSection header="Model" footer="Canvas size and frame rate are stored in the model file.">
            <ListRow icon="document" title="hana.r2d.json" subtitle="512 × 640 · 45 parts" trailing={<Badge tone="success">Valid</Badge>} />
            <ListRow icon="physics" iconColor="var(--r2-kind-physics)" title="Hair Physics" trailing={(id) => <Switch aria-labelledby={id} checked={physics} onChange={setPhysics} />} />
            <ListRow icon="film" iconColor="var(--r2-kind-animation)" title="Animations" trailing={<span>3</span>} disclosure onSelect={() => {}} />
            <ListRow icon="globe" title="Language" trailing={<span>한국어</span>} disclosure onSelect={() => {}} />
            <ListRow icon="trash" title="Delete Model" destructive onSelect={() => {}} />
          </ListSection>
        </List>
      </Specimen>

      <Specimen id="panels" title="Sidebar, Inspector" wide note="Panel shells: glass when they float over the canvas. Sidebar rows select; inspector rows pair a label with a control.">
        <div className="g-panels">
          <div className="g-panel-frame">
            <Sidebar title="Parts" header={<SearchField size="sm" placeholder="Search" />} actions={<IconButton icon="plus" label="Add" />}>
              <List variant="sidebar" size="sm" aria-label="Parts">
                <ListSection header="Head">
                  {['hairFront', 'face', 'eyeWhiteL', 'mouth'].map((id) => (
                    <ListRow key={id} icon="part" iconColor="var(--r2-kind-part)" title={id} selected={selected === id} onSelect={() => setSelected(id)} trailing={<IconButton icon="eye" label="Hide" size="sm" tooltip={false} />} />
                  ))}
                </ListSection>
                <ListSection header="Bones">
                  <ListRow icon="bone" iconColor="var(--r2-kind-bone)" title="root" expanded onSelect={() => setSelected('root')} selected={selected === 'root'} />
                  <ListRow icon="bone" iconColor="var(--r2-kind-bone)" title="body" level={1} onSelect={() => setSelected('body')} selected={selected === 'body'} />
                  <ListRow icon="bone" iconColor="var(--r2-kind-bone)" title="head" level={2} onSelect={() => setSelected('head')} selected={selected === 'head'} />
                </ListSection>
              </List>
            </Sidebar>
          </div>
          <div className="g-panel-frame">
            <Inspector title={selected} subtitle="Part" icon="part">
              <InspectorSection title="Transform">
                <InspectorRow label="Position">
                  <NumberField aria-label="X" prefix="X" size="sm" defaultValue={256} />
                  <NumberField aria-label="Y" prefix="Y" size="sm" defaultValue={234} />
                </InspectorRow>
                <InspectorRow label="Opacity" value="80%">
                  {(id) => <Slider aria-labelledby={id} size="sm" defaultValue={0.8} />}
                </InspectorRow>
                <InspectorRow label="Visible">{(id) => <Switch aria-labelledby={id} size="sm" defaultChecked />}</InspectorRow>
              </InspectorSection>
              <InspectorSection title="Bindings" defaultOpen={false}>
                <InspectorRow label="AngleX">
                  <Badge>3 keys</Badge>
                </InspectorRow>
              </InspectorSection>
            </Inspector>
          </div>
        </div>
      </Specimen>

      <Specimen id="toolbar" title="Toolbar" wide note="Glass capsule groups over the canvas, grouped by function; one tinted primary action on the trailing side. Arrow keys move between controls.">
        <Checkerboard className="g-toolbar-stage" cell={12}>
          <div className="g-toolbar-backdrop" />
          <Toolbar aria-label="Example" data-testid="toolbar">
            <ToolbarGroup aria-label="Document">
              <IconButton icon="chevronLeft" size="lg" label="Models" />
              <ToolbarTitle title="hana" subtitle="512 × 640" />
            </ToolbarGroup>
            <ToolbarSpacer />
            <ToolbarGroup aria-label="Tools">
              <IconButton icon="cursor" size="lg" label="Select" pressed />
              <IconButton icon="hand" size="lg" label="Pan" />
              <ToolbarSeparator />
              <IconButton icon="undo" size="lg" label="Undo" />
              <IconButton icon="redo" size="lg" label="Redo" />
            </ToolbarGroup>
            <ToolbarSpacer />
            <ToolbarGroup aria-label="Share">
              <IconButton icon="sparkles" size="lg" label="Generate" />
              <IconButton icon="export" size="lg" label="Export" />
            </ToolbarGroup>
            <Button variant="filled" size="xl">
              Done
            </Button>
          </Toolbar>
        </Checkerboard>
      </Specimen>

      <Specimen id="splitview" title="SplitView" wide note="Panes on the edges of a main area: drag a divider, or focus it and use the arrow keys; Enter collapses. Docked here; the editor mock uses the floating mode.">
        <div className="g-split-frame">
          <SplitView
            data-testid="splitview"
            panes={[
              { id: 'left', edge: 'leading', size: 180, min: 120, max: 280, collapsible: true, label: 'Sidebar', content: <div className="g-split-pane">Sidebar</div> },
              { id: 'right', edge: 'trailing', size: 200, min: 140, max: 300, collapsible: true, label: 'Inspector', content: <div className="g-split-pane">Inspector</div> },
              { id: 'bottom', edge: 'bottom', size: 72, min: 48, max: 160, label: 'Timeline', content: <div className="g-split-pane">Timeline</div> },
            ]}
          >
            <Checkerboard className="g-split-main">Canvas</Checkerboard>
          </SplitView>
        </div>
      </Specimen>

      <Specimen id="empty" title="EmptyState, Checkerboard" note="An empty area says what it is for and offers the action that fills it.">
        <div className="g-empty-frame">
          <EmptyState
            icon="image"
            title="Drop an Illustration"
            description="A front-facing bust with a transparent background works best."
            actions={
              <>
                <Button variant="filled" icon="folder">
                  Choose File…
                </Button>
                <Button variant="plain">Use an Example</Button>
              </>
            }
          />
        </div>
      </Specimen>

      <Specimen id="i18n" title="한국어 · 日本語" note="System fonts carry Korean and Japanese; Korean breaks between words. Labels may be longer than their English originals: controls grow, they do not clip.">
        <Row>
          <Button variant="filled">저장</Button>
          <Button variant="tinted" icon="sparkles">
            아바타 만들기
          </Button>
          <Button>취소</Button>
          <Button variant="filled">保存</Button>
          <Button variant="tinted" icon="sparkles">
            アバターを作成
          </Button>
          <Button>キャンセル</Button>
        </Row>
        <Row>
          <SegmentedControl
            aria-label="보기"
            defaultValue="parts"
            options={[
              { value: 'parts', label: '파츠' },
              { value: 'bones', label: '본' },
              { value: 'params', label: '파라미터' },
            ]}
          />
          <SegmentedControl
            aria-label="表示"
            defaultValue="parts"
            options={[
              { value: 'parts', label: 'パーツ' },
              { value: 'bones', label: 'ボーン' },
              { value: 'params', label: 'パラメータ' },
            ]}
          />
        </Row>
        <List variant="inset" aria-label="설정" lang="ko">
          <ListSection header="모델" footer="일러스트 한 장으로 눈을 깜빡이고 말하는 아바타를 만듭니다.">
            <ListRow icon="hair" title="머리카락 물리" subtitle="바람과 고개 움직임에 반응합니다" trailing={(id) => <Switch aria-labelledby={id} defaultChecked />} />
            <ListRow icon="globe" title="언어" trailing={<span>한국어</span>} disclosure onSelect={() => {}} />
          </ListSection>
        </List>
        <List variant="inset" aria-label="設定" lang="ja">
          <ListSection header="モデル" footer="一枚のイラストから、まばたきして話すアバターを作ります。">
            <ListRow icon="mic" title="リップシンク" subtitle="音声に合わせて口を動かします" trailing={(id) => <Switch aria-labelledby={id} defaultChecked />} />
            <ListRow icon="globe" title="言語" trailing={<span>日本語</span>} disclosure onSelect={() => {}} />
          </ListSection>
        </List>
      </Specimen>
    </div>
  );
}
