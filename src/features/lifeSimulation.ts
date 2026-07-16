import type { FeatureModule } from './types'

export const lifeSimulationModule: FeatureModule = {
  id: 'lifeSimulation', name: '世界生活模拟', icon: '🌙',
  description: '每次推进世界时，按世界日和四时段结算角色生活状态', parentId: 'character-soul',
}
