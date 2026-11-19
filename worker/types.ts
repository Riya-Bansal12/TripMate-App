export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  FIREBASE_PROJECT_ID?: string;
  AI_RATE_LIMITER?: RateLimitBinding;
  ASSETS?: AssetsBinding;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface VerifiedAuthContext {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}
