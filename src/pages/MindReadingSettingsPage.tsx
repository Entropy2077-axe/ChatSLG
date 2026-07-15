import { TopBar } from '../components/TopBar'
import { ThoughtBubble, type MindReadingStyle } from '../components/ThoughtBubble'
import { useSettingsStore } from '../store/useSettingsStore'

const STYLES: Array<{ value: MindReadingStyle; name: string; description: string }> = [
  { value: 'narration', name: '低调旁白卡片', description: '浅紫小卡片，清楚区分说出口的话和内心旁白' },
  { value: 'line', name: '细线独白', description: '只保留一条细线和文字，最简洁克制' },
  { value: 'pill', name: '心声胶囊', description: '圆润的小胶囊，读心能力的存在感更强' },
  { value: 'reveal', name: '可展开心声', description: '默认收起，点击“查看想法”后展开' },
]

export function MindReadingSettingsPage() {
  const enabled = useSettingsStore((state) => state.mindReadingEnabled ?? true)
  const selected = useSettingsStore((state) => state.mindReadingStyle ?? 'narration')
  const setSettings = useSettingsStore((state) => state.setSettings)

  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[#f4f4f6]">
      <TopBar title="读心样式" showBack />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!enabled && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">请先在设置中开启读心模式，再选择样式。</p>}
        <div className="space-y-3">
          {STYLES.map((option) => (
            <div
              key={option.value}
              className={`w-full rounded-2xl border bg-white p-3 text-left transition disabled:opacity-45 ${selected === option.value ? 'border-violet-500 ring-1 ring-violet-200' : 'border-gray-200'}`}
            >
              <button type="button" disabled={!enabled} onClick={() => setSettings({ mindReadingStyle: option.value })} className="mb-3 flex w-full items-start justify-between gap-3 text-left disabled:opacity-45">
                <div><p className="text-sm font-medium text-gray-800">{option.name}</p><p className="mt-0.5 text-[11px] text-gray-400">{option.description}</p></div>
                <span className={`mt-0.5 h-4 w-4 rounded-full border ${selected === option.value ? 'border-[5px] border-violet-600' : 'border-gray-300'}`} />
              </button>
              <div className="rounded-xl bg-[#ededed] p-3">
                <div className="mb-2 w-fit max-w-[82%] rounded-xl bg-white px-3 py-2 text-xs text-gray-800 shadow-sm">你怎么现在才回来</div>
                <div className="ml-2 max-w-[82%]"><ThoughtBubble thought="其实一直在等你，只是不好意思直接说。" style={option.value} /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
