import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from '@/context/AppContext';
import { ToastProvider } from '@/context/ToastContext';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/pages/auth/LoginPage';
import { SignupPage } from '@/pages/auth/SignupPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';
import { OnboardingPage } from '@/pages/onboarding/OnboardingPage';
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
import { AuthCallbackPage } from '@/pages/auth/AuthCallbackPage';
import type { ReactNode } from 'react';

function Protected({ children }: { children: ReactNode }) {
  const { user } = useApp();
  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user } = useApp();
  return user ? <Navigate to="/dashboard" replace /> : <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><SignupPage /></PublicOnly>} />
      <Route path="/forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
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
        <Route path="/demo-form" element={<DemoFormPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
