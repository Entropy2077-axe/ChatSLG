import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { useSettingsStore } from './store/useSettingsStore'
import { installConsoleCapture } from './lib/consoleCapture'
import { TabLayout } from './components/TabLayout'
import { NotificationBanner } from './components/NotificationBanner'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { ensureLegacyWorldviewMigrated } from './lib/worldbook'
import { ensureWorldInitialized } from './lib/world'
import { MessagesPage } from './pages/MessagesPage'
import { PhonePage } from './pages/PhonePage'
import { DialoguePage } from './pages/DialoguePage'
import { ContactsPage } from './pages/ContactsPage'
import { WorldPage } from './pages/WorldPage'
import { ChatPage } from './pages/ChatPage'
import { ContactCardPage } from './pages/ContactCardPage'
import { ContactAddPage } from './pages/ContactAddPage'
import { GroupAddPage } from './pages/GroupAddPage'
import { GroupInfoPage } from './pages/GroupInfoPage'
import { MomentsPage } from './pages/MomentsPage'
import { SettingsPage } from './pages/SettingsPage'
import { ProfileEditPage } from './pages/ProfileEditPage'
import { WorldSettingsPage } from './pages/WorldSettingsPage'
import { RelationshipsPage } from './pages/RelationshipsPage'
import { ShopPage } from './pages/ShopPage'
import { WarehousePage } from './pages/WarehousePage'
import { WorkPage } from './pages/WorkPage'
import { InterviewPage } from './pages/InterviewPage'
import { SaveLoadPage } from './pages/SaveLoadPage'
import { SkyEyePage } from './pages/SkyEyePage'
import { SocialInboxPage } from './pages/SocialInboxPage'
import { SceneArchivePage } from './pages/SceneArchivePage'
import { NewWorldPage } from './pages/NewWorldPage'
import { WebPrivacyNotice } from './components/WebPrivacyNotice'
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
  const location = useLocation()
  useEffect(() => { void ensureWorldInitialized() }, [])
  useEffect(() => { void ensureLegacyWorldviewMigrated() }, [])

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
    <AppErrorBoundary key={location.key}>
      <div className={`app-shell ${themeMode === 'dark' ? 'theme-dark' : ''}`}>
        <NotificationBanner />
        <WebPrivacyNotice />
        <Routes>
        <Route element={<TabLayout />}>
          <Route path="/" element={<Navigate to="/phone" replace />} />
          <Route path="/phone" element={<PhonePage />} />
          <Route path="/phone/messages" element={<MessagesPage />} />
          <Route path="/phone/moments" element={<MomentsPage />} />
          <Route path="/dialogue" element={<DialoguePage />} />
          <Route path="/locations" element={<WorldPage />} />
          <Route path="/me" element={<Navigate to="/phone" replace />} />
        </Route>
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/contact/new" element={<ContactAddPage />} />
        <Route path="/contact/:contactId" element={<ContactCardPage />} />
        <Route path="/group/new" element={<GroupAddPage />} />
        <Route path="/group/:groupId" element={<GroupInfoPage />} />
        <Route path="/social-inbox" element={<SocialInboxPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/scene-archives" element={<SceneArchivePage />} />
        <Route path="/new-world" element={<NewWorldPage />} />
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
        </Routes>
      </div>
    </AppErrorBoundary>
  )
}

export default App
