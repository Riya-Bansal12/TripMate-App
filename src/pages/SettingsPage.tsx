import React, { useState } from 'react';
import { CloudUpload, Download, Loader2, RotateCcw } from 'lucide-react';
import { AppLayout } from '../components/AppLayout';
import { useTripContext } from '../context/TripContext';

export const SettingsPage: React.FC = () => {
  const {
    settings,
    updateSettings,
    activeTrip,
    resetDemoData,
    showToast,
    migrationCandidate,
    migrationStatus,
    runLocalMigration,
  } = useTripContext();
  const [restoring, setRestoring] = useState(false);

  const handleExportTrip = () => {
    if (!activeTrip) return;
    const blob = new Blob([JSON.stringify(activeTrip, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTrip.destination.toLowerCase().replace(/\s+/g, '-')}-itinerary.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported active itinerary JSON');
  };

  const handleRestoreSample = async () => {
    setRestoring(true);
    try {
      await resetDemoData();
    } finally {
      setRestoring(false);
    }
  };

  return (
    <AppLayout
      title="Settings"
      subtitle="Configure planning rules, conflict warnings, and cloud synchronization"
    >
      <div className="max-w-3xl space-y-6">
        <section className="bg-white rounded-2xl border border-[#252B28]/10 p-6 sm:p-8 space-y-6">
          <h2 className="font-display text-lg font-semibold text-[#252B28]">
            Planner & Budget Behavior
          </h2>

          <div className="flex items-center justify-between gap-4 py-2 border-b border-[#252B28]/8">
            <div>
              <div className="text-sm font-semibold text-[#252B28]">
                Schedule Overlap Detection
              </div>
              <div className="text-xs text-[#5A645F]">
                Automatically compare start and end times and flag conflicting activities.
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.enableConflictDetection}
              onChange={(e) => updateSettings({ enableConflictDetection: e.target.checked })}
              className="w-5 h-5 accent-[#174B3A] cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between gap-4 py-2 border-b border-[#252B28]/8">
            <div>
              <div className="text-sm font-semibold text-[#252B28]">
                Auto-Sort Activities Chronologically
              </div>
              <div className="text-xs text-[#5A645F]">
                Keep day lists ordered by start time whenever activities are added or edited.
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.autoSortByTime}
              onChange={(e) => updateSettings({ autoSortByTime: e.target.checked })}
              className="w-5 h-5 accent-[#174B3A] cursor-pointer"
            />
          </div>

          <div className="py-2">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-semibold text-[#252B28]">
                  Budget Warning Threshold
                </div>
                <div className="text-xs text-[#5A645F]">
                  Show a budget alert once estimated expenses reach this percentage of your cap.
                </div>
              </div>
              <span className="font-mono text-sm font-semibold text-[#174B3A] tabular-nums">
                {settings.budgetWarningThresholdPct}%
              </span>
            </div>
            <input
              type="range"
              min={60}
              max={100}
              step={5}
              value={settings.budgetWarningThresholdPct}
              onChange={(e) =>
                updateSettings({ budgetWarningThresholdPct: Number(e.target.value) })
              }
              className="w-full accent-[#174B3A]"
            />
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-[#252B28]/10 p-6 sm:p-8 space-y-4">
          <h2 className="font-display text-lg font-semibold text-[#252B28]">
            Data & Cloud Sync
          </h2>
          <p className="text-xs text-[#5A645F]">
            All trips, activities, planned budgets, actual expenses, and preferences sync securely to your TripMate Cloud Firestore account.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleExportTrip}
              disabled={!activeTrip}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#F8F5EC] border border-[#252B28]/12 text-xs font-semibold text-[#174B3A] hover:bg-[#efe9d8] disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              <span>Export Active Trip JSON</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRestoreSample()}
              disabled={restoring}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-red-200 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {restoring ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RotateCcw className="w-4 h-4" />
              )}
              <span>Restore Sample Udaipur Trip</span>
            </button>

            {migrationCandidate && (
              <button
                type="button"
                onClick={() => void runLocalMigration()}
                disabled={migrationStatus === 'migrating'}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] disabled:opacity-60"
              >
                {migrationStatus === 'migrating' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CloudUpload className="w-4 h-4" />
                )}
                <span>Migrate Browser Trips ({migrationCandidate.counts.trips})</span>
              </button>
            )}
          </div>
        </section>
      </div>
    </AppLayout>
  );
};
