import React, { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { resolveTravelImageUrl } from '../data/destinations';

interface TravelImageProps {
  src?: string;
  alt: string;
  className?: string;
  fallbackTitle?: string;
}

export const TravelImage: React.FC<TravelImageProps> = ({
  src,
  alt,
  className = '',
  fallbackTitle,
}) => {
  const resolvedSrc = resolveTravelImageUrl(src);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [resolvedSrc]);

  if (!resolvedSrc || failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#174B3A]/15 via-[#F8F5EC] to-[#D8AC55]/25 text-[#174B3A] p-4 ${className}`}
        role="img"
        aria-label={alt}
      >
        <MapPin className="w-6 h-6 mb-1.5 opacity-70" />
        <span className="text-xs font-medium text-center line-clamp-2 opacity-80">
          {fallbackTitle || alt}
        </span>
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
};
