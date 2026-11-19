import React from 'react';
import { AlertTriangle, CloudUpload, Loader2, RefreshCw, X } from 'lucide-react';
import { useTripContext } from '../context/TripContext';

export const MigrationBannerModal: React.FC = () => {
  const {
    migrationCandidate,
    migrationStatus,
    migrationError,
    runLocalMigration,
    dismissLocalMigration,
  } = useTripContext();

  if (
    !migrationCandidate ||
    (migrationStatus !== 'available' &&
      migrationStatus !== 'migrating' &&
      migrationStatus !== 'failed')
  ) {
    return null;
  }

  const { counts } = migrationCandidate;
  const isMigrating = migrationStatus === 'migrating';
  const isFailed = migrationStatus === 'failed';

  return (
    <div
      className={`mb-6 rounded-2xl border p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
        isFailed
          ? 'bg-red-50 border-red-200 text-red-900'
          : 'bg-[#F8F5EC] border-[#174B3A]/20 text-[#252B28]'
      }`}
      role="region"
      aria-label="Local trip data migration"
    >
      <div className="flex items-start gap-3.5 min-w-0">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
            isFailed ? 'bg-red-100 text-red-700' : 'bg-[#174B3A] text-white'
          }`}
        >
          {isMigrating ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : isFailed ? (
            <AlertTriangle className="w-5 h-5" />
          ) : (
            <CloudUpload className="w-5 h-5" />
          )}
        </div>

        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold">
            {isFailed
              ? 'Cloud migration did not complete'
              : 'Existing local browser trips found'}
          </h2>
          <p className="text-xs text-[#5A645F] mt-0.5 leading-relaxed">
            {isFailed ? (
              <span className="text-red-800">
                {migrationError ||
                  'Your local browser data was preserved safely. Retry migrating to your TripMate account.'}
              </span>
            ) : (
              <>
                Found{' '}
                <span className="font-semibold text-[#252B28]">
                  {counts.trips} trip{counts.trips === 1 ? '' : 's'}
                </span>
                {counts.activities > 0 ? ` (${counts.activities} activities` : ''}
                {counts.expenses > 0 ? `, ${counts.expenses} actual expenses` : ''}
                {counts.activities > 0 ? ')' : ''} saved in this browser. Move them securely into
                your Cloud Firestore account so you can access them anywhere.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={() => void runLocalMigration()}
          disabled={isMigrating}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] transition-colors disabled:opacity-60 whitespace-nowrap"
        >
          {isMigrating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Migrating &amp; Verifying...</span>
            </>
          ) : isFailed ? (
            <>
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Migration</span>
            </>
          ) : (
            <>
              <CloudUpload className="w-3.5 h-3.5" />
              <span>Migrate to Cloud</span>
            </>
          )}
        </button>

        {!isMigrating && (
          <button
            type="button"
            onClick={() => void dismissLocalMigration()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-white border border-[#252B28]/15 text-xs font-semibold text-[#5A645F] hover:text-[#252B28] hover:bg-[#FCFBF7] transition-colors whitespace-nowrap"
          >
            <X className="w-3.5 h-3.5" />
            <span>Keep Local for Later</span>
          </button>
        )}
      </div>
    </div>
  );
};
