import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';
import './firebase';
import { TripProvider, useTripContext } from './context/TripContext';
import { UserAddressGateModal } from './components/UserAddressGateModal';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { TripWizard } from './pages/TripWizard';
import { ItineraryDashboard } from './pages/ItineraryDashboard';
import { DragDropPlanner } from './pages/DragDropPlanner';
import { AlternativesPage } from './pages/AlternativesPage';
import { ExpenseTracker } from './pages/ExpenseTracker';
import { ActualExpenseTracker } from './pages/ActualExpenseTracker';
import { MyTripsPage } from './pages/MyTripsPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, authLoading } = useTripContext();
  const location = useLocation();

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#FCFBF7] flex flex-col items-center justify-center gap-3 text-[#174B3A]">
        <Compass className="w-8 h-8 animate-spin" />
        <p className="text-sm font-medium text-[#5A645F]">Verifying TripMate session...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
};

export default function App() {
  return (
    <TripProvider>
      <BrowserRouter>
        <UserAddressGateModal />
        <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<AuthPage />} />
            <Route path="/signup" element={<AuthPage />} />
            <Route
              path="/create-trip"
              element={
                <ProtectedRoute>
                  <TripWizard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <ItineraryDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/planner"
              element={
                <ProtectedRoute>
                  <DragDropPlanner />
                </ProtectedRoute>
              }
            />
            <Route
              path="/alternatives"
              element={
                <ProtectedRoute>
                  <AlternativesPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/expenses"
              element={
                <ProtectedRoute>
                  <ExpenseTracker />
                </ProtectedRoute>
              }
            />
            <Route
              path="/actual-expenses"
              element={
                <ProtectedRoute>
                  <ActualExpenseTracker />
                </ProtectedRoute>
              }
            />
            <Route
              path="/trips"
              element={
                <ProtectedRoute>
                  <MyTripsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <ProfilePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <SettingsPage />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </TripProvider>
  );
}
