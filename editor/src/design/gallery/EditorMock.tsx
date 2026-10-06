/**
 * A static mock of the Rev2D editor built only from the design system, to judge the feel before the
 * real editor is restyled: a full-bleed canvas, a floating glass toolbar, a parts sidebar, an
 * inspector, a timeline drawer, a sheet and a toast. Nothing is saved; the inspector's pose sliders
 * do drive the placeholder character (it is a real Rev2D rig).
 */
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Checkerboard,
  Drawer,
  Icon,
  IconButton,
  Inspector,
  InspectorRow,
  InspectorSection,
  List,
  ListRow,
  ListSection,
  Menu,
  NumberField,
  SearchField,
  SegmentedControl,
  Select,
  Sheet,
  Sidebar,
  Slider,
  SplitView,
  Stepper,
  Switch,
  TextField,
  Toast,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarSpacer,
  initialDockState,
  toggleDock,
  useToast,
  type DockPaneSpec,
  type DockState,
  type IconName,
  type MenuEntry,
  type SplitPane,
} from '../index.js';
import { CharacterCanvas } from './character.js';

interface PartRow {
  id: string;
  name: string;
  icon: IconName;
  kind: 'part' | 'warp';
  level?: number;
  hidden?: boolean;
}

const TREE: Array<{ section: string; rows: PartRow[] }> = [
  {
    section: 'Head',
    rows: [
      { id: 'frontHairWarp', name: 'Front hair', icon: 'warp', kind: 'warp' },
      { id: 'hairFront', name: 'hairFront', icon: 'part', kind: 'part', level: 1 },
      { id: 'hairFrontShine', name: 'hairFrontShine', icon: 'part', kind: 'part', level: 1 },
      { id: 'faceWarp', name: 'Face', icon: 'warp', kind: 'warp' },
      { id: 'face', name: 'face', icon: 'part', kind: 'part', level: 1 },
      { id: 'eyeWhiteL', name: 'eyeWhiteL', icon: 'part', kind: 'part', level: 1 },
      { id: 'irisL', name: 'irisL', icon: 'part', kind: 'part', level: 1 },
      { id: 'mouth', name: 'mouth', icon: 'part', kind: 'part', level: 1 },
      { id: 'teeth', name: 'teeth', icon: 'part', kind: 'part', level: 1, hidden: true },
    ],
  },
  {
    section: 'Body',
    rows: [
      { id: 'bodyWarp', name: 'Body', icon: 'warp', kind: 'warp' },
      { id: 'collar', name: 'collar', icon: 'part', kind: 'part', level: 1 },
      { id: 'ribbonKnot', name: 'ribbonKnot', icon: 'part', kind: 'part', level: 1 },
      { id: 'blouse', name: 'blouse', icon: 'part', kind: 'part', level: 1 },
    ],
  },
];

const FILE_MENU: MenuEntry[] = [
  { id: 'new', label: 'New…', icon: 'fileNew', shortcut: 'Alt+N' },
  { id: 'open', label: 'Open…', icon: 'folder', shortcut: 'Ctrl+O' },
  { type: 'separator' },
  { id: 'save', label: 'Save', icon: 'save', shortcut: 'Ctrl+S' },
  { id: 'saveAs', label: 'Save As…', icon: 'saveAs', shortcut: 'Ctrl+Shift+S' },
  { id: 'export', label: 'Export…', icon: 'export' },
  { type: 'separator' },
  { id: 'close', label: 'Close Model', icon: 'fileClose', destructive: true },
];

const TRACKS: Array<{ id: string; label: string; keys: number[]; selected?: number }> = [
  { id: 'AngleX', label: 'AngleX', keys: [0, 1, 2, 3, 4] },
  { id: 'AngleY', label: 'AngleY', keys: [0, 1.4, 2.6, 4] },
  { id: 'EyeLOpen', label: 'Eye open', keys: [0, 2.8, 2.95, 3.1, 4], selected: 2 },
  { id: 'MouthOpen', label: 'MouthOpen', keys: [0, 0.6, 1.2, 1.8, 4], selected: 2 },
  { id: 'Breath', label: 'Breath', keys: [0, 2, 4] },
];

/** Dock layout of the mock: the toolbar on top, a full-width timeline drawer, the two side panels. */
const PANES = [
  { id: 'toolbar', edge: 'top', size: 44, min: 44, max: 44 },
  { id: 'timeline', edge: 'bottom', size: 200, min: 132, max: 420, maxFraction: 0.42, collapsible: true },
  { id: 'parts', edge: 'leading', size: 248, min: 200, max: 360, maxFraction: 0.23, collapsible: true },
  { id: 'inspector', edge: 'trailing', size: 288, min: 240, max: 420, maxFraction: 0.27, collapsible: true },
] as const satisfies readonly DockPaneSpec[];

const DURATION = 4;
const PLAYHEAD = 1.2;

function formatTime(t: number): string {
  const s = Math.floor(t);
  const f = Math.round((t - s) * 30);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export interface EditorMockProps {
  /** Start with the "new avatar" sheet open. */
  sheet?: boolean;
  /** Korean interface strings (to check CJK text in the real layout). */
  korean?: boolean;
}

export function EditorMock({ sheet = false, korean = false }: EditorMockProps) {
  const toast = useToast();
  const [pose, setPose] = useState({ AngleX: 12, AngleY: -4, EyeOpen: 1, MouthOpen: 0.2 });
  const [selected, setSelected] = useState('face');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ frontHairWarp: true, faceWarp: true, bodyWarp: true });
  const [hidden, setHidden] = useState<Record<string, boolean>>({ teeth: true });
  const [tab, setTab] = useState('parts');
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState<'cursor' | 'hand' | 'target'>('cursor');
  const [overlays, setOverlays] = useState({ bone: true, mesh: false, grid: false });
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [blend, setBlend] = useState('normal');
  const [visible, setVisible] = useState(true);
  const [opacity, setOpacity] = useState(1);
  const [z, setZ] = useState(21);
  const [animation, setAnimation] = useState('idle');
  const [sheetOpen, setSheetOpen] = useState(sheet);
  const [avatarName, setAvatarName] = useState(korean ? '하나' : 'Hana');
  const [avatarStyle, setAvatarStyle] = useState('bust');
  const [blink, setBlink] = useState(true);
  const [hairPhysics, setHairPhysics] = useState(true);

  const t = (en: string, ko: string): string => (korean ? ko : en);

  const params = useMemo(
    () => ({ AngleX: pose.AngleX, AngleY: pose.AngleY, EyeLOpen: pose.EyeOpen, EyeROpen: pose.EyeOpen, MouthOpen: pose.MouthOpen }),
    [pose],
  );

  const [dock, setDock] = useState<DockState>(() => initialDockState(PANES));

  const sidebar = (
    <Sidebar
      title={t('Parts', '파츠')}
      actions={
        <>
          <IconButton icon="plus" label={t('Add Part', '파츠 추가')} />
          <IconButton icon="more" label={t('More', '더 보기')} />
        </>
      }
      header={
        <>
          <SegmentedControl
            block
            size="sm"
            aria-label={t('Outline', '아웃라인')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'parts', label: t('Parts', '파츠') },
              { value: 'bones', label: t('Bones', '본') },
              { value: 'params', label: t('Params', '파라미터') },
            ]}
          />
          <SearchField size="sm" value={query} onChange={setQuery} placeholder={t('Search', '검색')} />
        </>
      }
    >
      <List variant="sidebar" size="sm" aria-label={t('Parts', '파츠')}>
        {TREE.map((group) => (
          <ListSection key={group.section} header={korean ? (group.section === 'Head' ? '머리' : '몸') : group.section}>
            {group.rows
              .filter((row, _i, all) => {
                if (query && !row.name.toLowerCase().includes(query.toLowerCase())) return false;
                if (row.level) {
                  // A child is shown while its warp (the closest level-0 row before it) is expanded.
                  const index = all.indexOf(row);
                  for (let i = index - 1; i >= 0; i--) if (!all[i]!.level) return expanded[all[i]!.id] !== false;
                }
                return true;
              })
              .map((row) => (
                <ListRow
                  key={row.id}
                  title={row.name}
                  icon={row.icon}
                  iconColor={row.kind === 'warp' ? 'var(--r2-kind-warp)' : 'var(--r2-kind-part)'}
                  level={row.level}
                  selected={selected === row.id}
                  onSelect={() => setSelected(row.id)}
                  expanded={row.kind === 'warp' ? expanded[row.id] !== false : undefined}
                  onExpandedChange={(open) => setExpanded((e) => ({ ...e, [row.id]: open }))}
                  data-dim={hidden[row.id] ? '' : undefined}
                  trailing={
                    <IconButton
                      icon={hidden[row.id] ? 'eyeOff' : 'eye'}
                      label={hidden[row.id] ? t('Show', '보이기') : t('Hide', '숨기기')}
                      size="sm"
                      tooltip={false}
                      className="g-row-eye"
                      onClick={() => setHidden((h) => ({ ...h, [row.id]: !h[row.id] }))}
                    />
                  }
                />
              ))}
          </ListSection>
        ))}
      </List>
    </Sidebar>
  );

  const poseRow = (id: keyof typeof pose, label: string, min: number, max: number, step: number, origin?: number) => (
    <InspectorRow key={id} label={label} layout="stack" value={pose[id].toFixed(step < 1 ? 2 : 0)}>
      {(labelId) => (
        <Slider
          aria-labelledby={labelId}
          data-testid={`mock-slider-${id}`}
          min={min}
          max={max}
          step={step}
          origin={origin}
          resetValue={origin ?? (id === 'EyeOpen' ? 1 : 0)}
          value={pose[id]}
          onChange={(v) => setPose((p) => ({ ...p, [id]: v }))}
        />
      )}
    </InspectorRow>
  );

  const inspector = (
    <Inspector title={selected} subtitle={t('Part · faceWarp', '파츠 · faceWarp')} icon="part" actions={<IconButton icon="more" label={t('More', '더 보기')} />}>
      <InspectorSection title={t('Pose', '포즈')} trailing={<IconButton icon="reset" size="sm" label={t('Reset Pose', '포즈 초기화')} onClick={() => setPose({ AngleX: 0, AngleY: 0, EyeOpen: 1, MouthOpen: 0 })} />}>
        {poseRow('AngleX', t('Angle X', '각도 X'), -30, 30, 1, 0)}
        {poseRow('AngleY', t('Angle Y', '각도 Y'), -30, 30, 1, 0)}
        {poseRow('EyeOpen', t('Eye Open', '눈 뜨기'), 0, 1, 0.01)}
        {poseRow('MouthOpen', t('Mouth Open', '입 벌리기'), 0, 1, 0.01)}
      </InspectorSection>
      <InspectorSection title={t('Appearance', '모양')}>
        <InspectorRow label={t('Visible', '보이기')}>{(labelId) => <Switch aria-labelledby={labelId} size="sm" checked={visible} onChange={setVisible} />}</InspectorRow>
        <InspectorRow label={t('Opacity', '불투명도')} value={`${Math.round(opacity * 100)}%`}>
          {(labelId) => <Slider aria-labelledby={labelId} size="sm" min={0} max={1} step={0.01} value={opacity} onChange={setOpacity} resetValue={1} />}
        </InspectorRow>
        <InspectorRow label={t('Blend', '블렌드')}>
          {(labelId) => (
            <Select
              aria-labelledby={labelId}
              variant="plain"
              value={blend}
              onChange={setBlend}
              options={[
                { value: 'normal', label: t('Normal', '표준') },
                { value: 'add', label: t('Add', '더하기') },
                { value: 'multiply', label: t('Multiply', '곱하기') },
                { value: 'screen', label: t('Screen', '스크린') },
              ]}
            />
          )}
        </InspectorRow>
        <InspectorRow label={t('Draw Order', '그리기 순서')}>
          <NumberField aria-label={t('Draw order', '그리기 순서')} size="sm" width={56} value={z} onChange={setZ} step={1} />
          <Stepper size="sm" value={z} onChange={setZ} decrementLabel={t('Send backward', '뒤로 보내기')} incrementLabel={t('Bring forward', '앞으로 가져오기')} />
        </InspectorRow>
      </InspectorSection>
      <InspectorSection title={t('Bindings', '바인딩')} trailing={<IconButton icon="plus" size="sm" label={t('Add Binding', '바인딩 추가')} />}>
        <List variant="plain" size="sm">
          <ListRow icon="warp" iconColor="var(--r2-kind-warp)" title="faceWarp.offsets" subtitle="AngleX × AngleY" trailing={<Badge>{t('9 keys', '키 9개')}</Badge>} disclosure onSelect={() => {}} />
          <ListRow icon="param" iconColor="var(--r2-kind-parameter)" title="opacity" subtitle="Cheek" trailing={<Badge>{t('2 keys', '키 2개')}</Badge>} disclosure onSelect={() => {}} />
        </List>
      </InspectorSection>
    </Inspector>
  );

  const playhead = PLAYHEAD / DURATION;
  const timeline = (
    <Drawer padded={false} aria-label={t('Timeline', '타임라인')}>
      <div className="g-tl">
        <div className="g-tl-bar">
          <div className="g-tl-transport">
            <IconButton icon="toStart" label={t('Go to Start', '처음으로')} shortcut="Home" />
            <IconButton icon={playing ? 'pause' : 'play'} label={playing ? t('Pause', '일시정지') : t('Play', '재생')} shortcut="Space" variant="tinted" onClick={() => setPlaying(!playing)} />
            <IconButton icon="repeat" label={t('Loop', '반복')} pressed={loop} onClick={() => setLoop(!loop)} />
          </div>
          <div className="g-tl-time r2-num" aria-label={t('Current time', '현재 시간')}>
            {formatTime(PLAYHEAD)}
            <span className="g-tl-duration"> / {formatTime(DURATION)}</span>
          </div>
          <Select
            aria-label={t('Animation', '애니메이션')}
            variant="plain"
            value={animation}
            onChange={setAnimation}
            options={[
              { value: 'idle', label: 'idle', icon: 'film' },
              { value: 'talk', label: 'talk', icon: 'film' },
              { value: 'wave', label: 'wave', icon: 'film' },
            ]}
          />
          <div className="g-tl-flex" />
          <Badge>30 fps</Badge>
          <IconButton icon="keyframe" label={t('Add Keyframe', '키프레임 추가')} shortcut="K" />
          <IconButton icon="chevronDown" label={t('Hide Timeline', '타임라인 숨기기')} onClick={() => setDock(toggleDock(dock, 'timeline', true))} />
        </div>
        <div className="g-tl-body r2-scroll">
          <div className="g-tl-labels">
            <div className="g-tl-ruler-gap" />
            {TRACKS.map((track) => (
              <div key={track.id} className="g-tl-label">
                <Icon name="param" size={14} style={{ color: 'var(--r2-kind-parameter)' }} />
                <span className="r2-truncate">{track.label}</span>
              </div>
            ))}
          </div>
          <div className="g-tl-lanes">
            <div className="g-tl-lanes-inner">
            <div className="g-tl-ruler r2-num" aria-hidden="true">
              {Array.from({ length: DURATION * 2 + 1 }, (_, i) => (
                <span key={i} className="g-tl-tick" data-major={i % 2 === 0 ? '' : undefined} style={{ left: `${(i / (DURATION * 2)) * 100}%` }}>
                  {i % 2 === 0 ? `${i / 2}s` : ''}
                </span>
              ))}
            </div>
            {TRACKS.map((track) => (
              <div key={track.id} className="g-tl-lane">
                <div className="g-tl-clip" style={{ left: `${(track.keys[0]! / DURATION) * 100}%`, right: `${100 - (track.keys[track.keys.length - 1]! / DURATION) * 100}%` }} />
                {track.keys.map((k, i) => (
                  <span key={i} className="g-tl-key" data-selected={track.selected === i ? '' : undefined} style={{ left: `${(k / DURATION) * 100}%` }} />
                ))}
              </div>
            ))}
            <div className="g-tl-playhead" style={{ left: `${playhead * 100}%` }} aria-hidden="true">
              <span className="g-tl-playhead-head" />
            </div>
            </div>
          </div>
        </div>
      </div>
    </Drawer>
  );

  const toolbar = (
    <Toolbar aria-label={t('Editor', '에디터')} data-testid="mock-toolbar">
      <ToolbarGroup aria-label={t('Document', '문서')}>
        <IconButton icon="sidebarLeft" size="lg" label={t('Sidebar', '사이드바')} aria-expanded={!dock.collapsed.parts} onClick={() => setDock(toggleDock(dock, 'parts'))} />
        <Menu items={FILE_MENU} aria-label={t('File', '파일')}>
          <Button variant="plain" size="lg" trailingIcon="chevronDown" className="g-doc-title">
            hana
          </Button>
        </Menu>
      </ToolbarGroup>
      <ToolbarSpacer />
      <ToolbarGroup aria-label={t('Tools', '도구')}>
        <IconButton icon="cursor" size="lg" label={t('Select', '선택')} shortcut="V" pressed={tool === 'cursor'} onClick={() => setTool('cursor')} />
        <IconButton icon="hand" size="lg" label={t('Pan', '이동')} shortcut="H" pressed={tool === 'hand'} onClick={() => setTool('hand')} />
        <IconButton icon="target" size="lg" label={t('Pivot', '피벗')} shortcut="P" pressed={tool === 'target'} onClick={() => setTool('target')} />
        <ToolbarSeparator />
        <IconButton icon="bone" size="lg" label={t('Bones', '본')} pressed={overlays.bone} onClick={() => setOverlays((o) => ({ ...o, bone: !o.bone }))} />
        <IconButton icon="mesh" size="lg" label={t('Mesh', '메시')} pressed={overlays.mesh} onClick={() => setOverlays((o) => ({ ...o, mesh: !o.mesh }))} />
        <IconButton icon="grid" size="lg" label={t('Grid', '격자')} pressed={overlays.grid} onClick={() => setOverlays((o) => ({ ...o, grid: !o.grid }))} />
      </ToolbarGroup>
      <ToolbarSpacer />
      <ToolbarGroup aria-label={t('History', '기록')}>
        <IconButton icon="undo" size="lg" label={t('Undo', '실행 취소')} shortcut="Ctrl+Z" />
        <IconButton icon="redo" size="lg" label={t('Redo', '다시 실행')} shortcut="Ctrl+Shift+Z" disabled />
      </ToolbarGroup>
      <ToolbarGroup aria-label={t('Panels', '패널')}>
        <IconButton icon="sparkles" size="lg" label={t('New Avatar from Illustration', '일러스트로 아바타 만들기')} data-testid="mock-open-sheet" onClick={() => setSheetOpen(true)} />
        <IconButton icon="export" size="lg" label={t('Export', '내보내기')} />
        <IconButton icon="sidebarRight" size="lg" label={t('Inspector', '인스펙터')} aria-expanded={!dock.collapsed.inspector} onClick={() => setDock(toggleDock(dock, 'inspector'))} />
      </ToolbarGroup>
      <Button variant="filled" size="xl" className="g-primary" data-testid="mock-save" onClick={() => toast.show({ id: 'saved', title: t('Saved hana.r2d.json', 'hana.r2d.json 저장됨'), tone: 'success' })}>
        {t('Save', '저장')}
      </Button>
    </Toolbar>
  );

  const content = { toolbar, timeline, parts: sidebar, inspector };
  const labels = { toolbar: 'Toolbar', timeline: t('Timeline', '타임라인'), parts: t('Sidebar', '사이드바'), inspector: t('Inspector', '인스펙터') };
  const panes: SplitPane[] = PANES.map((spec) => ({
    ...spec,
    label: labels[spec.id],
    content: content[spec.id],
    ...(spec.id === 'toolbar' ? { resizable: false, passthrough: true } : {}),
  }));

  return (
    <div className="g-mock" data-testid="editor-mock" lang={korean ? 'ko' : undefined}>
      <SplitView floating panes={panes} state={dock} onStateChange={setDock}>
        <div className="g-canvas">
          <div className="g-stage">
            <Checkerboard className="g-artboard" cell={10}>
              <CharacterCanvas params={params} className="g-character" />
              <svg className="g-selection" viewBox="0 0 512 640" aria-hidden="true">
                {overlays.grid && (
                  <g className="g-grid">
                    {Array.from({ length: 9 }, (_, i) => (
                      <line key={`v${i}`} x1={(i + 1) * 51.2} y1="0" x2={(i + 1) * 51.2} y2="640" />
                    ))}
                    {Array.from({ length: 11 }, (_, i) => (
                      <line key={`h${i}`} x1="0" y1={(i + 1) * 53.33} x2="512" y2={(i + 1) * 53.33} />
                    ))}
                  </g>
                )}
                {overlays.bone && (
                  <g className="g-bones">
                    <path d="M256 640L256 470M256 470L258 380M258 380L262 240" />
                    <circle cx="256" cy="470" r="5" />
                    <circle cx="258" cy="380" r="5" />
                    <circle cx="262" cy="240" r="5" />
                  </g>
                )}
                <rect className="g-selection-box" x="163" y="115" width="196" height="238" rx="3" />
                {[
                  [163, 115],
                  [359, 115],
                  [163, 353],
                  [359, 353],
                ].map(([x, y]) => (
                  <circle key={`${x}-${y}`} className="g-selection-handle" cx={x} cy={y} r="7" />
                ))}
                <line className="g-selection-stem" x1="261" y1="115" x2="261" y2="86" />
                <circle className="g-selection-handle" cx="261" cy="82" r="7" />
              </svg>
            </Checkerboard>
          </div>
          <div className="g-hud">
            <Toast title={t('Saved hana.r2d.json', 'hana.r2d.json 저장됨')} tone="success" data-testid="mock-toast" />
            <Toolbar size="md" aria-label={t('Zoom', '확대/축소')} className="g-zoom">
              <ToolbarGroup>
                <IconButton icon="zoomOut" label={t('Zoom Out', '축소')} />
                <span className="g-zoom-value r2-num">100%</span>
                <IconButton icon="zoomIn" label={t('Zoom In', '확대')} />
                <IconButton icon="fit" label={t('Fit', '맞춤')} shortcut="F" />
              </ToolbarGroup>
            </Toolbar>
          </div>
        </div>
      </SplitView>

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onConfirm={() => setSheetOpen(false)}
        title={t('New Avatar', '새 아바타')}
        size="md"
        data-testid="mock-sheet"
        leading={
          <Button variant="plain" size="lg" onClick={() => setSheetOpen(false)}>
            {t('Cancel', '취소')}
          </Button>
        }
        trailing={
          <Button variant="filled" size="lg" icon="sparkles" onClick={() => setSheetOpen(false)}>
            {t('Create', '만들기')}
          </Button>
        }
      >
        <div className="g-sheet-grid">
          <Checkerboard className="g-sheet-well" cell={8}>
            <CharacterCanvas params={{ AngleX: 0 }} className="g-sheet-thumb" />
          </Checkerboard>
          <div className="g-sheet-form">
            <p className="g-sheet-lead">
              {t(
                'Rev2D cuts one illustration into layers and builds a model that blinks, talks and turns its head.',
                '일러스트 한 장을 레이어로 나누어 눈을 깜빡이고, 말하고, 고개를 돌리는 모델을 만듭니다.',
              )}
            </p>
            <TextField label={t('Name', '이름')} value={avatarName} onChange={setAvatarName} data-autofocus="" />
            <SegmentedControl
              block
              aria-label={t('Framing', '구도')}
              value={avatarStyle}
              onChange={setAvatarStyle}
              options={[
                { value: 'bust', label: t('Bust', '상반신') },
                { value: 'half', label: t('Half Body', '반신') },
                { value: 'full', label: t('Full Body', '전신') },
              ]}
            />
            <List variant="inset">
              <ListSection>
                <ListRow icon="eyeClosed" title={t('Blink', '눈 깜빡임')} subtitle={t('Mesh fallback until drawn eyes arrive', '그린 눈이 준비될 때까지 메시로 대체')} trailing={(id) => <Switch aria-labelledby={id} checked={blink} onChange={setBlink} />} />
                <ListRow icon="hair" title={t('Hair Physics', '머리카락 물리')} trailing={(id) => <Switch aria-labelledby={id} checked={hairPhysics} onChange={setHairPhysics} />} />
                <ListRow icon="mic" title={t('Lip Sync', '립싱크')} trailing={<span>{t('5 Mouth Shapes', '입 모양 5개')}</span>} disclosure onSelect={() => {}} />
              </ListSection>
            </List>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
