/** Independent malformed landmarks for every authored-arm/leg semantic diagnostic. */
export const ARM_VALIDATION_CASES: {
  code: string;
  path: string;
  mutate: (doc: Record<string, any>) => void;
}[] = [
  {
    code: 'avatar-legs-missing',
    path: '/legs',
    mutate: (d) => {
      delete d.legs;
    },
  },
  {
    code: 'avatar-arm-outside-image',
    path: '/arms/0/shoulder',
    mutate: (d) => {
      d.arms[0].shoulder = [-1, 210];
    },
  },
  {
    code: 'avatar-arm-duplicate-id',
    path: '/arms/1/id',
    mutate: (d) => {
      d.arms[1].id = 'armR';
    },
  },
  {
    code: 'avatar-arm-segment-short',
    path: '/arms/0',
    mutate: (d) => {
      d.arms[0].elbow = d.arms[0].shoulder;
    },
  },
  {
    code: 'avatar-arm-hand-detached',
    path: '/arms/0/hand',
    mutate: (d) => {
      d.arms[0].hand.center = [20, 430];
    },
  },
  {
    code: 'avatar-arm-shoulder-detached',
    path: '/arms/0/shoulder',
    mutate: (d) => {
      d.arms[0].shoulder = [10, 20];
    },
  },
  {
    code: 'avatar-arm-outline',
    path: '/arms/0/outline',
    mutate: (d) => {
      d.arms[0].outline = [0, 0, 1, 1];
    },
  },
  {
    code: 'avatar-arm-outline-crosses',
    path: '/arms/0/outline',
    mutate: (d) => {
      d.arms[0].outline = [80, 220, 140, 300, 140, 220, 80, 300];
    },
  },
  {
    code: 'avatar-arm-outline-joint',
    path: '/arms/0/outline',
    mutate: (d) => {
      d.arms[0].outline = [10, 10, 20, 10, 20, 20, 10, 20];
    },
  },
  {
    code: 'avatar-legs-outside-image',
    path: '/legs/hips',
    mutate: (d) => {
      d.legs.hips = [-10, 300];
    },
  },
  {
    code: 'avatar-legs-feet-coincident',
    path: '/legs/feet',
    mutate: (d) => {
      d.legs.feet[1] = d.legs.feet[0];
    },
  },
  {
    code: 'avatar-legs-order',
    path: '/legs',
    mutate: (d) => {
      d.legs.feet[0] = [140, 100];
    },
  },
];
