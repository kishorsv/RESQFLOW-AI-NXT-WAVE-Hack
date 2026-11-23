import React from 'react';

interface BrandMarkProps {
  size?: number;
  className?: string;
}

/**
 * RESQFLOW AI geometric emergency-intelligence shield-network emblem.
 * Designed to stay crisp at 20px-64px without generic medical crosses.
 */
export const BrandMark: React.FC<BrandMarkProps> = ({ size = 28, className = '' }) => {
  const gradId = React.useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6D7CFF" />
          <stop offset="100%" stopColor="#35C8F5" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="38"
        height="38"
        rx="10"
        className="fill-[#0B1220] dark:fill-[#111A2A]"
        stroke={`url(#${gradId})`}
        strokeOpacity="0.45"
        strokeWidth="1.25"
      />
      <path
        d="M20 7.5L30.5 12V20.2C30.5 26.8 26 31.6 20 33.6C14 31.6 9.5 26.8 9.5 20.2V12L20 7.5Z"
        stroke={`url(#${gradId})`}
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M14 23.2L18.5 18.6L22 21.8L26.5 15.2"
        stroke="#35C8F5"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="23.2" r="1.75" fill="#6D7CFF" />
      <circle cx="18.5" cy="18.6" r="1.85" fill="#FFFFFF" />
      <circle cx="26.5" cy="15.2" r="2.1" fill="#35C8F5" />
    </svg>
  );
};
