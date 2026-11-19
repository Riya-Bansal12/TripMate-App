import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, MapPin, User } from 'lucide-react';
import { AppLayout } from '../components/AppLayout';
import { useTripContext } from '../context/TripContext';
import { TravelStyle } from '../types/trip';

const STYLES: TravelStyle[] = ['Adventure', 'Relaxed', 'Balanced', 'Custom'];

export const ProfilePage: React.FC = () => {
  const navigate = useNavigate();
  const { user, userAddress, setIsAddressModalOpen, trips, updateProfile } = useTripContext();

  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [homeCity, setHomeCity] = useState(
    user?.homeCity || userAddress?.city || userAddress?.label || 'Bengaluru'
  );
  const [defaultStyle, setDefaultStyle] = useState<TravelStyle>(
    user?.defaultTravelStyle || 'Balanced'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.photoURL]);

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
      setHomeCity(user.homeCity || userAddress?.city || userAddress?.label || 'Bengaluru');
      setDefaultStyle(user.defaultTravelStyle || 'Balanced');
    }
  }, [user, userAddress]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!user) {
      navigate('/login');
      return;
    }

    setSaving(true);
    const res = await updateProfile({
      name: name.trim() || 'Traveler',
      homeCity: homeCity.trim() || 'Bengaluru',
      defaultTravelStyle: defaultStyle,
    });
    setSaving(false);

    if (!res.ok) {
      setError(res.error || 'Unable to save profile changes.');
    }
  };

  return (
    <AppLayout title="Traveler Profile" subtitle="Manage your personal defaults and travel preferences">
      <div className="max-w-3xl space-y-6">
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {user?.photoURL && !avatarFailed ? (
              <img
                src={user.photoURL}
                alt={name || 'Traveler'}
                referrerPolicy="no-referrer"
                onError={() => setAvatarFailed(true)}
                className="w-14 h-14 rounded-2xl object-cover shrink-0 border border-[#252B28]/10"
              />
            ) : (
              <div className="w-14 h-14 rounded-2xl bg-[#174B3A] text-white font-display text-xl font-semibold flex items-center justify-center shrink-0">
                {name
                  .split(' ')
                  .filter(Boolean)
                  .map((p) => p[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase() || <User className="w-6 h-6" />}
              </div>
            )}
            <div>
              <h2 className="font-display text-xl font-semibold text-[#252B28]">
                {name || 'Traveler'}
              </h2>
              <div className="text-xs text-[#5A645F] mt-0.5">
                {email} · {trips.length} saved trip{trips.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          {!user && (
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="px-4 py-2 rounded-xl bg-[#F8F5EC] text-[#174B3A] text-xs font-semibold hover:bg-[#efe9d8]"
            >
              Sign In / Switch Account
            </button>
          )}
        </div>

        <div className="bg-[#F8F5EC] rounded-2xl border border-[#252B28]/10 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <MapPin className="w-5 h-5 text-[#174B3A] shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold text-[#174B3A]">
                Starting Address
              </div>
              <div className="text-sm font-medium text-[#252B28] mt-0.5">
                {userAddress?.formattedAddress || 'No starting address saved yet'}
              </div>
              <div className="text-xs text-[#5A645F] mt-0.5">
                Used to pre-fill your departure city across new trips.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsAddressModalOpen(true)}
            className="px-4 py-2 rounded-xl bg-white border border-[#252B28]/15 text-xs font-semibold text-[#174B3A] hover:bg-[#FCFBF7] whitespace-nowrap shrink-0"
          >
            {userAddress ? 'Change Address' : 'Set Address'}
          </button>
        </div>

        <form
          onSubmit={handleSave}
          className="bg-white rounded-2xl border border-[#252B28]/10 p-6 sm:p-8 space-y-5"
        >
          <h3 className="font-display text-lg font-semibold text-[#252B28]">
            Traveler Details
          </h3>

          {error && (
            <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Full Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                readOnly
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#F8F5EC] text-sm text-[#5A645F] cursor-not-allowed focus:outline-none"
                title="Verified account email managed via Firebase Authentication"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Origin City
              </label>
              <input
                type="text"
                value={homeCity}
                onChange={(e) => setHomeCity(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Default Travel Style
              </label>
              <select
                value={defaultStyle}
                onChange={(e) => setDefaultStyle(e.target.value as TravelStyle)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              >
                {STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#174B3A] text-white text-sm font-semibold hover:bg-[#123B2D] disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              <span>{saving ? 'Saving...' : 'Save Profile'}</span>
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
};
