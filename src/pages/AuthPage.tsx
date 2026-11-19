import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Compass, Loader2, Lock, Mail, User } from 'lucide-react';
import { useTripContext } from '../context/TripContext';
import { GENERATED_IMAGES } from '../data/destinations';
import { TravelImage } from '../components/TravelImage';

export const AuthPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    isAuthenticated,
    authLoading,
    login,
    register,
    loginWithGoogle,
    resendVerificationEmail,
    resetPassword,
  } = useTripContext();

  const initialMode = location.pathname === '/signup' ? 'signup' : 'login';
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  const redirectTarget =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || '/dashboard';

  useEffect(() => {
    setMode(location.pathname === '/signup' ? 'signup' : 'login');
    setError('');
    setNotice('');
    setNeedsVerification(false);
    setForgotOpen(false);
    setResetSent(false);
  }, [location.pathname]);

  if (!authLoading && isAuthenticated) {
    return <Navigate to={redirectTarget} replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setNeedsVerification(false);

    if (mode === 'login') {
      setSubmitting(true);
      const res = await login(email, password, rememberMe);
      setSubmitting(false);

      if (!res.ok) {
        setError(res.error || 'Unable to sign in.');
        if (res.needsVerification) {
          setNeedsVerification(true);
        }
        return;
      }
      navigate(redirectTarget, { replace: true });
    } else {
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      setSubmitting(true);
      const res = await register(fullName, email, password);
      setSubmitting(false);

      if (!res.ok) {
        setError(res.error || 'Unable to create account.');
        return;
      }

      setConfirmPassword('');
      setMode('login');
      setNeedsVerification(true);
      setNotice(
        `Verification email sent to ${res.email || email}. Please verify your email address via the link in your inbox, then sign in.`
      );
    }
  };

  const handleGoogleLogin = async () => {
    setError('');
    setNotice('');
    setNeedsVerification(false);
    setGoogleLoading(true);
    const res = await loginWithGoogle();
    setGoogleLoading(false);

    if (!res.ok) {
      setError(res.error || 'Unable to sign in with Google.');
      return;
    }
    navigate(redirectTarget, { replace: true });
  };

  const handleResendVerification = async () => {
    setError('');
    setNotice('');
    setResendingVerification(true);
    const res = await resendVerificationEmail(email, password);
    setResendingVerification(false);

    if (!res.ok) {
      setError(res.error || 'Unable to resend verification email.');
      return;
    }

    if (res.needsVerification) {
      setNotice(
        `Verification email re-sent to ${res.email || email}. Please check your inbox and spam folder.`
      );
    } else {
      setNotice('Your email is already verified. You can sign in now.');
      setNeedsVerification(false);
    }
  };

  const handleSendPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResetSent(false);
    setSendingReset(true);
    const res = await resetPassword(email);
    setSendingReset(false);

    if (!res.ok) {
      setError(res.error || 'Unable to send password reset email.');
      return;
    }
    setResetSent(true);
  };

  return (
    <div className="min-h-screen bg-[#FCFBF7] grid grid-cols-1 lg:grid-cols-12">
      {/* Left Photography Column */}
      <div className="hidden lg:block lg:col-span-6 relative overflow-hidden">
        <TravelImage
          src={GENERATED_IMAGES.kerala}
          alt="Kerala backwaters at golden dawn"
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/30 to-black/20" />
        <div className="relative z-10 h-full p-12 flex flex-col justify-between text-white">
          <Link
            to="/"
            className="font-display text-2xl font-semibold flex items-center gap-2.5 w-fit"
          >
            <Compass className="w-6 h-6 text-[#D8AC55]" />
            <span>TripMate</span>
          </Link>

          <div className="max-w-md">
            <h2 className="font-display text-3xl font-semibold leading-snug [text-wrap:balance]">
              Every edit shapes the journey.
            </h2>
            <p className="mt-3 text-sm text-white/85 leading-relaxed">
              Save multiple custom itineraries, compare budget allocations across days, and keep every trip organized in your TripMate workspace.
            </p>
          </div>
        </div>
      </div>

      {/* Right Auth Card */}
      <div className="lg:col-span-6 flex flex-col justify-center px-6 py-10 sm:px-12 lg:px-16">
        <div className="w-full max-w-md mx-auto">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#5A645F] hover:text-[#174B3A] mb-8"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Home</span>
          </Link>

          <div className="flex items-center gap-1 p-1 bg-[#F8F5EC] rounded-xl border border-[#252B28]/10 mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError('');
                setNotice('');
                setNeedsVerification(false);
                setForgotOpen(false);
                setResetSent(false);
              }}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-colors ${
                mode === 'login' ? 'bg-white text-[#174B3A] shadow-sm' : 'text-[#5A645F]'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError('');
                setNotice('');
                setNeedsVerification(false);
                setForgotOpen(false);
                setResetSent(false);
              }}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-colors ${
                mode === 'signup' ? 'bg-white text-[#174B3A] shadow-sm' : 'text-[#5A645F]'
              }`}
            >
              Create Account
            </button>
          </div>

          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-[#252B28]">
            {mode === 'login' ? 'Welcome back' : 'Start planning with TripMate'}
          </h1>
          <p className="mt-1.5 text-sm text-[#5A645F]">
            {mode === 'login'
              ? 'Sign in to access your saved itineraries and expense trackers.'
              : 'Create a traveler profile to build and persist personalized trips.'}
          </p>

          {error && (
            <div className="mt-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700 space-y-2">
              <p>{error}</p>
              {needsVerification && (
                <button
                  type="button"
                  onClick={handleResendVerification}
                  disabled={resendingVerification}
                  className="inline-flex items-center gap-1.5 font-semibold text-[#174B3A] underline hover:text-[#123B2D] disabled:opacity-60"
                >
                  {resendingVerification && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>
                    {resendingVerification
                      ? 'Resending verification email...'
                      : 'Resend verification email'}
                  </span>
                </button>
              )}
            </div>
          )}

          {notice && (
            <div className="mt-4 px-4 py-3 rounded-xl bg-[#F8F5EC] border border-[#174B3A]/25 text-xs font-medium text-[#174B3A] space-y-2">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#174B3A]" />
                <p className="leading-relaxed">{notice}</p>
              </div>
              {needsVerification && (
                <button
                  type="button"
                  onClick={handleResendVerification}
                  disabled={resendingVerification}
                  className="inline-flex items-center gap-1.5 font-semibold underline hover:text-[#123B2D] disabled:opacity-60 pl-6"
                >
                  {resendingVerification && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>
                    {resendingVerification
                      ? 'Resending verification email...'
                      : 'Resend verification email'}
                  </span>
                </button>
              )}
            </div>
          )}

          {forgotOpen ? (
            <form
              onSubmit={handleSendPasswordReset}
              className="mt-6 bg-white rounded-2xl border border-[#252B28]/10 p-6 space-y-4"
            >
              <h2 className="text-base font-semibold text-[#252B28]">Reset your password</h2>
              <p className="text-xs text-[#5A645F]">
                Enter your registered account email and we will send you a password reset link.
              </p>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              />
              {resetSent && (
                <div className="text-xs font-medium text-[#174B3A] bg-[#F8F5EC] border border-[#174B3A]/20 px-3 py-2.5 rounded-lg">
                  Password reset email sent to {email}. Check your inbox and follow the link to choose a new password.
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setForgotOpen(false);
                    setResetSent(false);
                    setError('');
                  }}
                  className="text-xs font-medium text-[#5A645F] hover:text-[#252B28]"
                >
                  Back to Sign In
                </button>
                <button
                  type="submit"
                  disabled={sendingReset}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#174B3A] text-white text-xs font-semibold hover:bg-[#123B2D] disabled:opacity-60"
                >
                  {sendingReset && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{sendingReset ? 'Sending...' : 'Send Reset Link'}</span>
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              {mode === 'signup' && (
                <div>
                  <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                    Full Name
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-[#5A645F] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Simar Kaur"
                      required
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-white text-sm focus:outline-none focus:border-[#174B3A]"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#5A645F] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="traveler@example.com"
                    required
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-white text-sm focus:outline-none focus:border-[#174B3A]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#5A645F] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    required
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-white text-sm focus:outline-none focus:border-[#174B3A]"
                  />
                </div>
              </div>

              {mode === 'signup' && (
                <div>
                  <label className="block text-xs font-semibold text-[#252B28] mb-1.5">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-[#5A645F] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      required
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-white text-sm focus:outline-none focus:border-[#174B3A]"
                    />
                  </div>
                </div>
              )}

              {mode === 'login' && (
                <div className="flex items-center justify-between text-xs">
                  <label className="inline-flex items-center gap-2 text-[#5A645F] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      className="rounded border-[#252B28]/30 text-[#174B3A] focus:ring-[#174B3A]"
                    />
                    <span>Remember me</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setForgotOpen(true);
                      setError('');
                      setNotice('');
                      setResetSent(false);
                    }}
                    className="font-medium text-[#174B3A] hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || googleLoading || authLoading}
                className="w-full py-3 rounded-xl bg-[#174B3A] text-white text-sm font-semibold hover:bg-[#123B2D] transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>
                  {submitting
                    ? mode === 'login'
                      ? 'Signing in...'
                      : 'Creating account...'
                    : mode === 'login'
                    ? 'Sign In to Workspace'
                    : 'Create Traveler Account'}
                </span>
              </button>

              <div className="relative py-2">
                <div className="border-t border-[#252B28]/10" />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#FCFBF7] px-3 text-xs text-[#5A645F]">
                  or
                </span>
              </div>

              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={submitting || googleLoading || authLoading}
                className="w-full py-2.5 rounded-xl bg-[#F8F5EC] border border-[#252B28]/12 text-[#174B3A] text-sm font-semibold hover:bg-[#efe9d8] transition-colors flex items-center justify-center gap-2.5 disabled:opacity-60"
              >
                {googleLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                    />
                  </svg>
                )}
                <span>{googleLoading ? 'Connecting Google...' : 'Continue with Google'}</span>
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
