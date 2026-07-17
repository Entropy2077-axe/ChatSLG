import type { AiEvalScenario } from './types'

const contact = (key: string, name: string, persona: string, currentLocation: 'home' | 'livingRoom' | 'cafe' | 'inaudible' = 'home') => ({
  key,
  name,
  persona,
  currentLocation,
})

const alice = contact('alice', '林夏', '直率但不刻薄，愿意明确表达同意或拒绝。')
const bo = contact('bo', '周博', '爱接梗，话不多，表达自然。')
const chen = contact('chen', '陈安', '安静谨慎，不会替别人做决定。')
const dai = contact('dai', '戴宁', '活泼外向，喜欢参与轻松话题。')

const state = (
  id: string,
  category: AiEvalScenario['category'],
  description: string,
  inputMessages: string[],
  expectedState: NonNullable<AiEvalScenario['expectedState']>,
  evidence: NonNullable<AiEvalScenario['evidence']>,
  overrides: Partial<AiEvalScenario> = {},
): AiEvalScenario => ({
  id,
  category,
  description,
  initialWorldState: '隔离世界第1天白天，角色位于住所，地点树和世界版本有效。',
  contacts: [alice],
  groupMembers: ['alice'],
  initialLocations: { alice: 'home' },
  initialOutfits: { alice: '白色T恤、牛仔裤、无外套、无配饰' },
  initialSchedules: [],
  inputMessages,
  expectedHardResults: Object.keys(expectedState).length
    ? Object.entries(expectedState).map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    : ['按角色独立验证预期状态'],
  forbiddenResults: ['非法ID写入', '未同意角色的状态被改变', '用户正式数据被访问'],
  repetitions: 1,
  timeoutMs: 45_000,
  useRealModel: true,
  kind: 'state',
  stateScene: 'private_phone',
  evidence,
  expectedState,
  ...overrides,
})

const endToEndState = (
  id: string,
  category: AiEvalScenario['category'],
  description: string,
  userMessage: string,
  expectedState: NonNullable<AiEvalScenario['expectedState']>,
  overrides: Partial<AiEvalScenario> = {},
): AiEvalScenario => ({
  id,
  suite: 'acceptance',
  coverage: 'end_to_end',
  category,
  description,
  initialWorldState: '隔离世界第1天白天，角色位于住所；用户输入必须先经过真实聊天引擎，再检查状态裁决和最终数据库。',
  contacts: [{ ...alice, persona: `${alice.persona} 面对合理、明确的测试请求会自然地明确答应并照做；面对疑问、照片描述或含糊建议不会假装已经执行。` }],
  groupMembers: ['alice'],
  initialLocations: { alice: 'home' },
  initialOutfits: { alice: '白色T恤、牛仔裤、无外套、无配饰' },
  initialSchedules: [],
  inputMessages: [userMessage],
  expectedHardResults: ['真实聊天回复成功', '状态裁决完成', ...Object.entries(expectedState).map(([key, value]) => `${key}=${JSON.stringify(value)}`)],
  forbiddenResults: ['预先伪造角色同意证据', '只调用状态裁决器而绕过聊天引擎', '用户正式数据被访问'],
  repetitions: 2,
  timeoutMs: 120_000,
  useRealModel: true,
  kind: 'state_e2e',
  stateScene: 'private_phone',
  expectedState,
  ...overrides,
})

export const AI_EVAL_SCENARIOS: AiEvalScenario[] = [
  ...([
    ['private-quiet', 'quiet', 1, 2, '我刚忙完，有点累。'],
    ['private-normal', 'normal', 3, 4, '今天发生了一件挺好笑的事。'],
    ['private-lively', 'lively', 7, 7, '我终于把拖了很久的事情做完了！'],
  ] as const).map(([id, liveliness, minBubbles, maxBubbles, message]): AiEvalScenario => ({
    id,
    category: 'private_reply',
    description: `私聊${liveliness === 'quiet' ? '安静' : liveliness === 'normal' ? '正常' : '热闹'}模式的回复数量、格式和基础自然度。`,
    initialWorldState: '角色手机可用，私聊上下文为空。',
    contacts: [alice],
    groupMembers: ['alice'],
    initialLocations: { alice: 'home' },
    initialOutfits: { alice: '默认衣着' },
    initialSchedules: [],
    inputMessages: [message],
    expectedHardResults: [`产生${minBubbles}–${maxBubbles}条回复`, '解析成功并写入数据库'],
    forbiddenResults: ['完全复读用户输入', '每条都机械使用同一句话', '用户数据库被访问'],
    repetitions: 2,
    timeoutMs: 90_000,
    useRealModel: true,
    kind: 'private',
    private: { liveliness, minBubbles, maxBubbles },
  })),
  {
    id: 'group-quiet-one-audible',
    category: 'group_liveliness',
    description: '地点群聊只有1名可听见角色，冷清模式不得出现非法发言者。',
    initialWorldState: '林夏在现场；周博位于不可听见地点。',
    contacts: [{ ...alice, currentLocation: 'livingRoom' }, { ...bo, currentLocation: 'inaudible' }],
    groupMembers: ['alice', 'bo'],
    initialLocations: { alice: 'livingRoom', bo: 'inaudible' },
    initialOutfits: {},
    initialSchedules: [],
    inputMessages: ['这里有人吗？'],
    expectedHardResults: ['产生1–2条回复', '不同发言人不超过1', '无不可听见角色发言'],
    forbiddenResults: ['周博发言'],
    repetitions: 2,
    timeoutMs: 90_000,
    useRealModel: true,
    kind: 'group',
    group: { channel: 'scene', energy: 'cold', speakerLimit: 'all', minimumDistinctSpeakers: 1 },
  },
  {
    id: 'group-normal-two',
    category: 'group_liveliness',
    description: '普通群聊2名角色，一般模式检查3–4条总气泡。',
    initialWorldState: '两名角色均可用手机。',
    contacts: [alice, bo],
    groupMembers: ['alice', 'bo'],
    initialLocations: { alice: 'home', bo: 'home' },
    initialOutfits: {},
    initialSchedules: [],
    inputMessages: ['你们今天都遇到什么好玩的事了？'],
    expectedHardResults: ['产生3–4条回复', '发言者来自群成员'],
    forbiddenResults: ['群外角色发言'],
    repetitions: 3,
    timeoutMs: 90_000,
    useRealModel: true,
    kind: 'group',
    group: { channel: 'group_phone', energy: 'normal', speakerLimit: 'all', minimumDistinctSpeakers: 2 },
  },
  {
    id: 'group-lively-four-open-topic',
    category: 'group_liveliness',
    description: '4人地点群聊热闹模式，开放话题连续运行并分开统计气泡数与多人参与。',
    initialWorldState: '四名角色均在现场。',
    contacts: [{ ...alice, currentLocation: 'livingRoom' }, { ...bo, currentLocation: 'livingRoom' }, { ...chen, currentLocation: 'livingRoom' }, { ...dai, currentLocation: 'livingRoom' }],
    groupMembers: ['alice', 'bo', 'chen', 'dai'],
    initialLocations: { alice: 'livingRoom', bo: 'livingRoom', chen: 'livingRoom', dai: 'livingRoom' },
    initialOutfits: {},
    initialSchedules: [],
    inputMessages: ['大家各自推荐一个周末最想做的事，随便聊聊。'],
    expectedHardResults: ['产生7条回复', '至少3名不同角色参与', '所有发言者合法'],
    forbiddenResults: ['只有1–2条仍被判条数达标', '不在场角色发言'],
    repetitions: 10,
    timeoutMs: 90_000,
    useRealModel: true,
    kind: 'group',
    group: { channel: 'scene', energy: 'lively', speakerLimit: 'all', minimumDistinctSpeakers: 3 },
  },
  {
    id: 'group-lively-mentioned',
    category: 'group_liveliness',
    description: '热闹群聊明确@林夏，检查被@者参与且总气泡仍独立达标。',
    initialWorldState: '四名角色均在普通手机群。',
    contacts: [alice, bo, chen, dai],
    groupMembers: ['alice', 'bo', 'chen', 'dai'],
    initialLocations: { alice: 'home', bo: 'home', chen: 'home', dai: 'home' },
    initialOutfits: {},
    initialSchedules: [],
    inputMessages: ['@林夏 你先说说，其他人也可以补充。'],
    expectedHardResults: ['林夏发言', '产生7条回复', '至少3名不同角色参与'],
    forbiddenResults: ['被@者未参与', '群外角色发言'],
    repetitions: 3,
    timeoutMs: 90_000,
    useRealModel: true,
    kind: 'group',
    group: { channel: 'group_phone', energy: 'lively', speakerLimit: 'all', mention: 'alice', minimumDistinctSpeakers: 3 },
  },

  state('outfit-put-on-coat', 'outfit', '立即穿上黑色外套。', ['现在穿上黑色外套。', '好，我现在穿上。'], { outfit: 'applied', outfitPatch: { outerwear: '黑色外套' }, schedule: 'unchanged', location: 'unchanged' }, [
    { actor: 'user', content: '现在穿上黑色外套。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，我现在穿上。', perceivedBy: ['alice'] },
  ]),
  state('outfit-remove-coat', 'outfit', '脱掉已有外套。', ['把外套脱掉。', '好，脱掉了。'], { outfit: 'applied', outfitPatch: { outerwear: '无' } }, [
    { actor: 'user', content: '把外套脱掉。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，脱掉了。', perceivedBy: ['alice'] },
  ], { contacts: [{ ...alice, outfit: { outerwear: '黑色外套' } }], initialOutfits: { alice: '黑色外套' } }),
  state('outfit-white-top', 'outfit', '更换白色上衣。', ['换成白色上衣。', '行，换好了。'], { outfit: 'applied', outfitPatch: { top: '白色上衣' } }, [
    { actor: 'user', content: '换成白色上衣。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '行，换好了。', perceivedBy: ['alice'] },
  ]),
  state('outfit-bow', 'outfit', '戴上蝴蝶结，必须写accessories。', ['戴上蝴蝶结。', '好呀，戴上了。'], { outfit: 'applied', outfitPatch: { accessories: '蝴蝶结' } }, [
    { actor: 'user', content: '戴上蝴蝶结。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好呀，戴上了。', perceivedBy: ['alice'] },
  ]),
  state('outfit-bow-seven-days', 'outfit', '连续七天佩戴蝴蝶结，属于未来衣着约束而非日程。', ['接下来七天都戴蝴蝶结。', '可以。'], { outfit: 'applied', outfitPatch: { accessories: '蝴蝶结' }, outfitStartDayOffset: 0, outfitEndDayOffset: 6, schedule: 'unchanged' }, [
    { actor: 'user', content: '接下来七天都戴蝴蝶结。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '可以。', perceivedBy: ['alice'] },
  ]),
  state('outfit-photo-negative', 'outfit', '照片描述不得修改现实衣着。', ['你照片里穿着白衬衫。'], { outfit: 'unchanged' }, [
    { actor: 'user', content: '你照片里穿着白衬衫。', perceivedBy: ['alice'] },
  ]),
  state('outfit-question-negative', 'outfit', '询问是否换衣不得直接修改。', ['你要不要换件衣服？'], { outfit: 'unchanged' }, [
    { actor: 'user', content: '你要不要换件衣服？', perceivedBy: ['alice'] },
  ]),
  state('outfit-refusal-negative', 'outfit', '角色明确拒绝不得修改衣着。', ['穿上黑色外套吧。', '不要，我不想穿。'], { outfit: 'unchanged' }, [
    { actor: 'user', content: '穿上黑色外套吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '不要，我不想穿。', perceivedBy: ['alice'] },
  ]),
  state('outfit-short-consent', 'outfit', '具体请求后只回复“好”仍应理解为同意。', ['换成白色上衣。', '好。'], { outfit: 'applied', outfitPatch: { top: '白色上衣' } }, [
    { actor: 'user', content: '换成白色上衣。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好。', perceivedBy: ['alice'] },
  ]),
  state('outfit-multiple-parts', 'outfit', '一句话同时修改多个衣着部位。', ['换上白色上衣、黑色外套，再戴蝴蝶结。', '好，都换上了。'], { outfit: 'applied', outfitPatch: { top: '白色上衣', outerwear: '黑色外套', accessories: '蝴蝶结' } }, [
    { actor: 'user', content: '换上白色上衣、黑色外套，再戴蝴蝶结。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，都换上了。', perceivedBy: ['alice'] },
  ]),
  state('outfit-duplicate', 'outfit', '已经是目标衣着时不得重复写入。', ['你继续穿着白色上衣就好。', '好。'], { outfit: 'unchanged' }, [
    { actor: 'user', content: '你继续穿着白色上衣就好。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好。', perceivedBy: ['alice'] },
  ], { contacts: [{ ...alice, outfit: { top: '白色上衣' } }], initialOutfits: { alice: '白色上衣' } }),

  state('schedule-tomorrow-cafe', 'schedule', '明晚咖啡厅安排被明确接受。', ['明天晚上去咖啡厅吧。', '好，明晚见。'], { schedule: 'applied', scheduleLocation: 'cafe', scheduleDayOffset: 1, scheduleSlots: ['evening'], location: 'unchanged' }, [
    { actor: 'user', content: '明天晚上去咖啡厅吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，明晚见。', perceivedBy: ['alice'] },
  ]),
  state('schedule-later-today', 'schedule', '今天稍后去咖啡厅，只改日程不立即移动。', ['今天晚上去咖啡厅吧。', '行，晚上过去。'], { schedule: 'applied', scheduleLocation: 'cafe', scheduleDayOffset: 0, scheduleSlots: ['evening'], location: 'unchanged' }, [
    { actor: 'user', content: '今天晚上去咖啡厅吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '行，晚上过去。', perceivedBy: ['alice'] },
  ]),
  state('schedule-multiple-days', 'schedule', '连续三天的咖啡厅安排。', ['从明天起连续三天，晚上都去咖啡厅。', '可以，就这么安排。'], { schedule: 'applied', scheduleLocation: 'cafe', scheduleDayOffset: 1, scheduleEndDayOffset: 3, scheduleSlots: ['evening'] }, [
    { actor: 'user', content: '从明天起连续三天，晚上都去咖啡厅。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '可以，就这么安排。', perceivedBy: ['alice'] },
  ]),
  state('schedule-suggestion-negative', 'schedule', '只有建议没有接受，不写日程。', ['明天晚上可以去咖啡厅。'], { schedule: 'unchanged' }, [
    { actor: 'user', content: '明天晚上可以去咖啡厅。', perceivedBy: ['alice'] },
  ]),
  state('schedule-refusal-negative', 'schedule', '明确拒绝，不写日程。', ['明天晚上去咖啡厅吧。', '不行，我明晚不去。'], { schedule: 'unchanged' }, [
    { actor: 'user', content: '明天晚上去咖啡厅吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '不行，我明晚不去。', perceivedBy: ['alice'] },
  ]),
  state('schedule-missing-details-negative', 'schedule', '日期、时段和地点不完整时不得写入日程。', ['改天一起出去吧。', '好啊。'], { schedule: 'unchanged' }, [
    { actor: 'user', content: '改天一起出去吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好啊。', perceivedBy: ['alice'] },
  ]),
  state('schedule-illegal-location-negative', 'schedule', '不存在的地点不得写入日程。', ['明天晚上去月球基地吧。', '好，明晚去。'], { schedule: 'unchanged' }, [
    { actor: 'user', content: '明天晚上去月球基地吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，明晚去。', perceivedBy: ['alice'] },
  ]),
  state('schedule-duplicate', 'schedule', '同一约定已经存在时不得重复写入；不产生决定或返回duplicate都算正确。', ['明天晚上去咖啡厅喝咖啡吧。', '好，按原计划。'], { schedule: 'no_write' }, [
    { actor: 'user', content: '明天晚上去咖啡厅喝咖啡吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，按原计划。', perceivedBy: ['alice'] },
  ], { preexistingSchedule: { contact: 'alice', location: 'cafe', dayOffset: 1, slots: ['evening'], activity: '喝咖啡' } }),
  state('schedule-multi-one-consents', 'schedule', '多人约会只有一人同意，只能写入同意者状态。', ['你们明晚一起去咖啡厅吧。', '林夏：我同意。', '周博：我不去。'], {}, [
    { actor: 'user', content: '你们明晚一起去咖啡厅吧。', perceivedBy: ['alice', 'bo'] },
    { actor: 'alice', content: '我同意，明晚去咖啡厅。', perceivedBy: ['alice', 'bo'] },
    { actor: 'bo', content: '我不去。', perceivedBy: ['alice', 'bo'] },
  ], {
    contacts: [alice, bo],
    groupMembers: ['alice', 'bo'],
    stateScene: 'group_phone',
    expectedStateByContact: {
      alice: { schedule: 'applied', scheduleLocation: 'cafe', scheduleDayOffset: 1, scheduleSlots: ['evening'] },
      bo: { schedule: 'unchanged' },
    },
  }),
  state('schedule-bow-negative', 'schedule', '连续佩戴配饰不得误识别为日程。', ['接下来七天都戴蝴蝶结。', '好。'], { outfit: 'applied', schedule: 'unchanged' }, [
    { actor: 'user', content: '接下来七天都戴蝴蝶结。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好。', perceivedBy: ['alice'] },
  ]),

  state('location-now-consent', 'location', '现在去客厅并明确同意，应立即移动。', ['现在去客厅吧。', '好，现在过去。'], { location: 'applied', locationTarget: 'livingRoom', schedule: 'unchanged' }, [
    { actor: 'user', content: '现在去客厅吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，现在过去。', perceivedBy: ['alice'] },
  ]),
  state('location-tomorrow-negative', 'location', '明天去客厅只能改日程，不能立即移动。', ['明天晚上去客厅吧。', '好，明晚过去。'], { location: 'unchanged', schedule: 'applied', scheduleLocation: 'livingRoom', scheduleDayOffset: 1, scheduleSlots: ['evening'] }, [
    { actor: 'user', content: '明天晚上去客厅吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，明晚过去。', perceivedBy: ['alice'] },
  ]),
  state('location-wish-negative', 'location', '只有想去但没有行动，不移动。', ['我想去客厅。'], { location: 'unchanged' }, [
    { actor: 'user', content: '我想去客厅。', perceivedBy: ['alice'] },
  ]),
  state('location-refusal-negative', 'location', '角色拒绝，不移动。', ['现在去客厅吧。', '不要，我不去。'], { location: 'unchanged' }, [
    { actor: 'user', content: '现在去客厅吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '不要，我不去。', perceivedBy: ['alice'] },
  ]),
  state('location-duplicate', 'location', '角色已在客厅，不重复移动。', ['继续待在客厅吧。', '好。'], { location: 'unchanged' }, [
    { actor: 'user', content: '继续待在客厅吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好。', perceivedBy: ['alice'] },
  ], { contacts: [{ ...alice, currentLocation: 'livingRoom' }], initialLocations: { alice: 'livingRoom' } }),
  state('location-illegal-negative', 'location', '非法地点不得写入当前位置。', ['现在去月球基地吧。', '好，现在去。'], { location: 'unchanged' }, [
    { actor: 'user', content: '现在去月球基地吧。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，现在去。', perceivedBy: ['alice'] },
  ]),
  state('location-multi-consent', 'location', '地点群聊中两个角色分别同意移动，两者都应独立更新。', ['你们现在一起去客厅吧。', '林夏：好，现在去。', '周博：行，我也去。'], {}, [
    { actor: 'user', content: '你们现在一起去客厅吧。', perceivedBy: ['alice', 'bo'] },
    { actor: 'alice', content: '好，现在去客厅。', perceivedBy: ['alice', 'bo'] },
    { actor: 'bo', content: '行，我也现在去客厅。', perceivedBy: ['alice', 'bo'] },
  ], {
    contacts: [alice, bo],
    groupMembers: ['alice', 'bo'],
    stateScene: 'scene',
    expectedStateByContact: {
      alice: { location: 'applied', locationTarget: 'livingRoom' },
      bo: { location: 'applied', locationTarget: 'livingRoom' },
    },
  }),
  state('location-silent-listener', 'location', '在场但未发言角色不能被当成已同意；单独记录是否漏判。', ['你们现在一起去客厅吧。', '林夏：好，现在去。'], {}, [
    { actor: 'user', content: '你们现在一起去客厅吧。', perceivedBy: ['alice', 'bo'] },
    { actor: 'alice', content: '好，我现在去客厅。', perceivedBy: ['alice', 'bo'] },
  ], {
    contacts: [alice, bo],
    groupMembers: ['alice', 'bo'],
    stateScene: 'scene',
    expectedStateByContact: {
      alice: { location: 'applied', locationTarget: 'livingRoom' },
      bo: { location: 'unchanged' },
    },
  }),

  state('multi-state-all', 'multi_state', '同一轮同时移动、连续穿戴和登记明晚安排，三项必须独立提交。', ['现在去客厅，从今天起连续七天戴蝴蝶结，明晚去咖啡厅。', '好，现在去客厅；蝴蝶结也戴七天，明晚咖啡厅见。'], {
    outfit: 'applied', outfitPatch: { accessories: '蝴蝶结' }, outfitStartDayOffset: 0, outfitEndDayOffset: 6,
    schedule: 'applied', scheduleLocation: 'cafe', scheduleDayOffset: 1, scheduleSlots: ['evening'],
    location: 'applied', locationTarget: 'livingRoom',
  }, [
    { actor: 'user', content: '现在去客厅，从今天起连续七天戴蝴蝶结，明晚去咖啡厅。', perceivedBy: ['alice'] },
    { actor: 'alice', content: '好，现在去客厅；蝴蝶结也戴七天，明晚咖啡厅见。', perceivedBy: ['alice'] },
  ], { repetitions: 3 }),

  // Acceptance cases deliberately use colloquial wording and the complete
  // production chat path. They are not fed scripted assistant evidence.
  endToEndState(
    'acceptance-e2e-outfit-colloquial',
    'outfit',
    '未参与规则修复的口语化衣着请求，完整经过私聊与状态提交。',
    '外头有点凉，把那件黑外套套上吧。',
    { outfit: 'applied', outfitPatch: { outerwear: '黑色外套' }, schedule: 'unchanged', location: 'unchanged' },
  ),
  endToEndState(
    'acceptance-e2e-schedule-colloquial',
    'schedule',
    '口语化未来约定必须经过真实回复后写入日程，不能提前移动。',
    '明儿晚上咖啡厅碰头，成不成？',
    { schedule: 'applied', scheduleLocation: 'cafe', scheduleDayOffset: 1, scheduleSlots: ['evening'], location: 'unchanged' },
  ),
  endToEndState(
    'acceptance-e2e-location-colloquial',
    'location',
    '口语化立即移动请求经过完整生产链路后更新当前位置。',
    '别在卧室待着了，走，去客厅坐会儿。',
    { location: 'applied', locationTarget: 'livingRoom', schedule: 'unchanged' },
  ),
  endToEndState(
    'acceptance-e2e-photo-negative',
    'outfit',
    '真实聊天中谈到旧照片衣着不得污染现实衣着。',
    '你那张旧照片里穿的黑外套挺好看的。',
    { outfit: 'unchanged', schedule: 'unchanged', location: 'unchanged' },
  ),
  endToEndState(
    'acceptance-e2e-ambiguous-negative',
    'location',
    '含糊愿望经过真实聊天后不得被当成立即行动。',
    '有时候还挺想去客厅坐坐的。',
    { outfit: 'unchanged', schedule: 'unchanged', location: 'unchanged' },
  ),
  endToEndState(
    'acceptance-e2e-multi-state-colloquial',
    'multi_state',
    '未见口语表达同时覆盖立即移动、持续衣着和未来日程。',
    '走，先去客厅；这礼拜都戴着蝴蝶结吧，明儿晚上咱们咖啡厅见。',
    {
      outfit: 'applied', outfitPatch: { accessories: '蝴蝶结' }, outfitStartDayOffset: 0, outfitEndDayOffset: 6,
      schedule: 'applied', scheduleLocation: 'cafe', scheduleDayOffset: 1, scheduleSlots: ['evening'],
      location: 'applied', locationTarget: 'livingRoom',
    },
    { repetitions: 3 },
  ),

  ...([
    ['fault-non-json', 'non_json', '状态模型返回非JSON。'],
    ['fault-missing-fields', 'missing_fields', '状态模型JSON缺少必要字段。'],
    ['fault-wrong-character', 'wrong_character_id', '状态模型返回错误characterId。'],
    ['fault-wrong-evidence', 'wrong_evidence_id', '状态模型返回错误evidenceId。'],
    ['fault-invalid-location', 'invalid_location_id', '状态模型返回非法locationId。'],
    ['fault-timeout', 'timeout', 'API请求超时。'],
    ['fault-429', 'http_429', 'API持续返回429。'],
    ['fault-500', 'http_500', 'API持续返回500。'],
    ['fault-network', 'network_error', '网络中断。'],
    ['fault-transaction', 'transaction_error', '数据库事务异常。'],
    ['fault-main-ok-state-failed', 'main_ok_state_failed', '主模型成功但状态模型失败。'],
    ['fault-state-ok-commit-failed', 'state_ok_commit_failed', '状态模型成功但数据库提交失败。'],
    ['fault-non-leaf-location', 'non_leaf_location', '非叶子地点被确定性校验拒绝。'],
    ['fault-stale-world-version', 'stale_world_version', '过期worldVersion被确定性校验拒绝。'],
  ] as const).map(([id, fault, description]): AiEvalScenario => ({
    id,
    suite: 'development',
    coverage: ['timeout', 'http_429', 'http_500', 'network_error'].includes(fault) ? 'fault_injection' : 'classification_only',
    category: 'fault_recovery',
    description,
    initialWorldState: '隔离mock环境。',
    contacts: [alice],
    groupMembers: ['alice'],
    initialLocations: { alice: 'home' },
    initialOutfits: { alice: '默认衣着' },
    initialSchedules: [],
    inputMessages: ['现在去客厅吧。', '好。'],
    expectedHardResults: ['错误被归入正确阶段和类型', '不污染数据库', '保留失败输出'],
    forbiddenResults: ['把故障当成真实模型成功', '写入用户数据库'],
    repetitions: 1,
    timeoutMs: 5_000,
    useRealModel: false,
    kind: 'fault',
    fault,
  })),
]

export const scenarioById = (id: string) => AI_EVAL_SCENARIOS.find((scenario) => scenario.id === id)
