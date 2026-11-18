import { BrowserRouter, HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from '@/context/AppContext';
import { ToastProvider } from '@/context/ToastContext';
import { AppShell } from '@/components/layout/AppShell';
import { OverviewPage } from '@/pages/dashboard/OverviewPage';
import { DocumentsPage } from '@/pages/documents/DocumentsPage';
import { PersonalProfilePage } from '@/pages/records/PersonalProfilePage';
import { AddressesPage } from '@/pages/records/AddressesPage';
import { EducationPage } from '@/pages/records/EducationPage';
import { EmploymentPage } from '@/pages/records/EmploymentPage';
import { SkillsPage } from '@/pages/records/SkillsPage';
import { CollectionsPage } from '@/pages/collections/CollectionsPage';
import { HistoryPage } from '@/pages/history/HistoryPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { ExtensionSetupPage } from '@/pages/extension/ExtensionSetupPage';
import { DemoFormPage } from '@/pages/demo/DemoFormPage';
import { VaultSetupPage } from '@/pages/vault/VaultSetupPage';
import { VaultUnlockPage } from '@/pages/vault/VaultUnlockPage';
import { VaultMigrationPage } from '@/pages/vault/VaultMigrationPage';
import { OnboardingPage } from '@/pages/onboarding/OnboardingPage';
import type { ReactNode } from 'react';

function Protected({ children }: { children: ReactNode }) {
  const { vaultState } = useApp();
  if (vaultState === 'loading') return <div className="ff-empty"><span className="ff-spinner" /></div>;
  if (vaultState === 'locked') return <Navigate to="/unlock" replace />;
  if (vaultState === 'no_vault' || vaultState === 'migration_required') return <Navigate to="/setup" replace />;
  if (vaultState === 'error') return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { vaultState } = useApp();
  if (vaultState === 'loading') return <div className="ff-empty"><span className="ff-spinner" /></div>;
  return vaultState === 'unlocked' ? <Navigate to="/dashboard" replace /> : <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/setup" element={<PublicOnly><VaultSetupPage /></PublicOnly>} />
      <Route path="/unlock" element={<PublicOnly><VaultUnlockPage /></PublicOnly>} />
      <Route path="/onboarding" element={<Protected><OnboardingPage /></Protected>} />
      <Route element={<Protected><AppShell /></Protected>}>
        <Route path="/dashboard" element={<OverviewPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/records/personal" element={<PersonalProfilePage />} />
        <Route path="/records/addresses" element={<AddressesPage />} />
        <Route path="/records/education" element={<EducationPage />} />
        <Route path="/records/employment" element={<EmploymentPage />} />
        <Route path="/records/skills" element={<SkillsPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/extension" element={<ExtensionSetupPage />} />
        <Route path="/vault/migration" element={<VaultMigrationPage />} />
        <Route path="/demo-form" element={<DemoFormPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

const Router = typeof window !== 'undefined' && window.location.protocol === 'chrome-extension:'
  ? HashRouter
  : BrowserRouter;

export function App() {
  return (
    <Router>
      <ToastProvider>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </ToastProvider>
    </Router>
  );
}


