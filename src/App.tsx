import { lazy, Suspense, useEffect, type ComponentType } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { useSettingsStore } from './store/useSettingsStore'
import { installConsoleCapture } from './lib/consoleCapture'
import { TabLayout } from './components/TabLayout'
import { NotificationBanner } from './components/NotificationBanner'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { WebPrivacyNotice } from './components/WebPrivacyNotice'

const page = <T extends Record<K, ComponentType>, K extends keyof T>(loader: () => Promise<T>, name: K) =>
  lazy(async () => ({ default: (await loader())[name] }))
const MessagesPage = page(() => import('./pages/MessagesPage'), 'MessagesPage')
const PhonePage = page(() => import('./pages/PhonePage'), 'PhonePage')
const DialoguePage = page(() => import('./pages/DialoguePage'), 'DialoguePage')
const ContactsPage = page(() => import('./pages/ContactsPage'), 'ContactsPage')
const WorldPage = page(() => import('./pages/WorldPage'), 'WorldPage')
const ChatPage = page(() => import('./pages/ChatPage'), 'ChatPage')
const ContactCardPage = page(() => import('./pages/ContactCardPage'), 'ContactCardPage')
const ContactArchivePage = page(() => import('./pages/ContactArchivePage'), 'ContactArchivePage')
const ContactAddPage = page(() => import('./pages/ContactAddPage'), 'ContactAddPage')
const GroupAddPage = page(() => import('./pages/GroupAddPage'), 'GroupAddPage')
const GroupInfoPage = page(() => import('./pages/GroupInfoPage'), 'GroupInfoPage')
const MomentsPage = page(() => import('./pages/MomentsPage'), 'MomentsPage')
const SettingsPage = page(() => import('./pages/SettingsPage'), 'SettingsPage')
const MindReadingSettingsPage = page(() => import('./pages/MindReadingSettingsPage'), 'MindReadingSettingsPage')
const ProfileEditPage = page(() => import('./pages/ProfileEditPage'), 'ProfileEditPage')
const WorldSettingsPage = page(() => import('./pages/WorldSettingsPage'), 'WorldSettingsPage')
const RelationshipsPage = page(() => import('./pages/RelationshipsPage'), 'RelationshipsPage')
const ShopPage = page(() => import('./pages/ShopPage'), 'ShopPage')
const WarehousePage = page(() => import('./pages/WarehousePage'), 'WarehousePage')
const WorkPage = page(() => import('./pages/WorkPage'), 'WorkPage')
const InterviewPage = page(() => import('./pages/InterviewPage'), 'InterviewPage')
const SaveLoadPage = page(() => import('./pages/SaveLoadPage'), 'SaveLoadPage')
const SkyEyePage = page(() => import('./pages/SkyEyePage'), 'SkyEyePage')
const SocialInboxPage = page(() => import('./pages/SocialInboxPage'), 'SocialInboxPage')
const SceneArchivePage = page(() => import('./pages/SceneArchivePage'), 'SceneArchivePage')
const TimePage = page(() => import('./pages/TimePage'), 'TimePage')
const NewWorldPage = page(() => import('./pages/NewWorldPage'), 'NewWorldPage')
const AlbumPage = page(() => import('./pages/AlbumPage'), 'AlbumPage')
// Runs once at module load, regardless of admin mode — so there's already
// log history by the time someone opens "天眼".
installConsoleCapture()


/**
 * Without this, Android's hardware/gesture back button just closes the
 * whole app from any screen — Capacitor's default is to let the native
 * WebView's own back-navigation stack drive it, but this app is a
 * HashRouter SPA where "navigate back" means moving through the hash
 * history, not the WebView's page-load history. `canGoBack` is Capacitor's
 * own answer to "is there anywhere to go back to" (tracked natively from
 * the WebView's history), so this defers to it rather than guessing from
 * the current route. No-ops harmlessly on web (the browser's own back
 * button/gesture already works there; this listener just never fires).
 */
function useAndroidBackButton() {
  useEffect(() => {
    const listenerPromise = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back()
      } else {
        CapacitorApp.exitApp()
      }
    })
    return () => {
      listenerPromise.then((l) => l.remove())
    }
  }, [])
}

function App() {
  useAndroidBackButton()
  const themeMode = useSettingsStore((s) => s.themeMode ?? 'light')
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled ?? true)
  const adminModeEnabled = useSettingsStore((s) => s.adminModeEnabled)
  const atlasImageEnabled = useSettingsStore((s) => s.atlasImageEnabled)
  const atlasApiKey = useSettingsStore((s) => s.atlasApiKey)
  const location = useLocation()
  useEffect(() => { void import('./lib/world').then(({ ensureWorldInitialized }) => ensureWorldInitialized()) }, [])
  useEffect(() => { void import('./lib/worldbook').then(({ ensureLegacyWorldviewMigrated }) => ensureLegacyWorldviewMigrated()) }, [])
  useEffect(() => { if (atlasImageEnabled && atlasApiKey) void import('./lib/atlasImage').then(({ resumeAtlasGenerations }) => resumeAtlasGenerations(useSettingsStore.getState())) }, [atlasImageEnabled, atlasApiKey])

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
  }, [themeMode])
  useEffect(() => {
    document.documentElement.dataset.animations = animationsEnabled ? 'on' : 'off'
  }, [animationsEnabled])
  useEffect(() => {
    if (!animationsEnabled) return
    const shell = document.querySelector<HTMLElement>('.app-shell')
    if (!shell) return
    shell.classList.remove('page-transition')
    void shell.offsetWidth
    shell.classList.add('page-transition')
  }, [location.pathname, animationsEnabled])

  return (
    <AppErrorBoundary>
      <div className={`app-shell ${themeMode === 'dark' ? 'theme-dark' : ''}`}>
        <NotificationBanner />
        <WebPrivacyNotice />
        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-gray-400">加载中…</div>}>
        <Routes>
        <Route element={<TabLayout />}>
          <Route path="/" element={<Navigate to="/phone" replace />} />
          <Route path="/phone" element={<PhonePage />} />
          <Route path="/phone/messages" element={<MessagesPage />} />
          <Route path="/phone/moments" element={<MomentsPage />} />
          <Route path="/dialogue" element={<DialoguePage />} />
          <Route path="/locations" element={<WorldPage />} />
          <Route path="/time" element={<TimePage />} />
          <Route path="/me" element={<Navigate to="/phone" replace />} />
        </Route>
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/contact/new" element={<ContactAddPage />} />
        <Route path="/contact/:contactId" element={<ContactCardPage />} />
        <Route path="/contact/:contactId/archives" element={<ContactArchivePage />} />
        <Route path="/group/new" element={<GroupAddPage />} />
        <Route path="/group/:groupId" element={<GroupInfoPage />} />
        <Route path="/social-inbox" element={<SocialInboxPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/mind-reading" element={<MindReadingSettingsPage />} />
        <Route path="/settings/scene-archives" element={<SceneArchivePage />} />
        <Route path="/new-world" element={<NewWorldPage />} />
        <Route path="/album" element={<AlbumPage />} />
        <Route path="/stickers" element={<Navigate to="/phone" replace />} />
        <Route path="/profile/edit" element={<ProfileEditPage />} />
        <Route path="/modules" element={<Navigate to="/phone" replace />} />
        <Route path="/world-settings" element={<WorldSettingsPage />} />
        <Route path="/relationships" element={<RelationshipsPage />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route path="/warehouse" element={<WarehousePage />} />
        <Route path="/work" element={<WorkPage />} />
        <Route path="/work/interview/:jobId" element={<InterviewPage />} />
        <Route path="/save-load" element={<SaveLoadPage />} />
        {adminModeEnabled && (
          <Route path="/sky-eye" element={<SkyEyePage />} />
        )}
        <Route path="*" element={<Navigate to="/phone" replace />} />
        </Routes>
        </Suspense>
      </div>
    </AppErrorBoundary>
  )
}

export default App
