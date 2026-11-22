export function StagePortrait() {
  return (
    <svg className="stage-portrait" viewBox="0 0 360 390" aria-hidden="true">
      <defs>
        <linearGradient id="stage-hair" x1="0" y1="0" x2=".9" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#ffdf9a" /><stop offset=".55" stopColor="#c79257" /><stop offset="1" stopColor="#685066" />
        </linearGradient>
        <linearGradient id="stage-coat" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#f9e9cb" /><stop offset="1" stopColor="#536482" />
        </linearGradient>
        <linearGradient id="stage-face" x1="0" y1="0" x2=".9" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#ffe2b1" /><stop offset="1" stopColor="#bd8674" />
        </linearGradient>
        <linearGradient id="stage-fade" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
          <stop offset=".70" stopColor="white" /><stop offset="1" stopColor="black" />
        </linearGradient>
        <mask id="stage-portrait-mask"><rect width="360" height="390" fill="url(#stage-fade)" /></mask>
      </defs>
      <g fill="none" stroke="#efc983">
        <circle cx="180" cy="177" r="130" opacity=".52" />
        <circle cx="180" cy="177" r="144" opacity=".23" />
        <path d="M26 177h24m260 0h24M180 24v23m0 260v21M62 92h12m-6-6v12m219-25h16m-8-8v16M50 268h16m-8-8v16m247-14h10m-5-5v10" opacity=".65" />
      </g>
      <g mask="url(#stage-portrait-mask)">
        <path d="M180 69c-58-5-94 40-98 100-4 50-29 79-16 122 8 27 34 41 66 38l101-4c43 1 72-21 62-63-5-21-19-45-19-88 0-60-39-101-96-105Z" fill="url(#stage-hair)" stroke="#f6ce8c" strokeWidth="1.3" />
        <path d="M168 252c-15 20-39 24-61 32-34 13-44 49-49 106h244c-6-57-16-93-51-106-20-8-43-12-59-32Z" fill="url(#stage-coat)" />
        <path d="m104 286 25 50 21-13 30 29 30-29 21 13 26-49m-156 43-11 60m169-60 11 60" fill="none" stroke="#53617e" strokeWidth="2" />
        <path d="M158 219h44l5 42-27 22-27-22Z" fill="url(#stage-face)" />
        <path d="M111 161c-2-51 32-78 69-78 47 0 72 36 70 84-3 52-32 80-70 80-37 0-66-30-69-86Z" fill="url(#stage-face)" />
        <path d="M87 192c0-78 24-115 81-120 56-8 109 25 109 114l-22 57-12-36 3-34c-19-2-45-17-67-49-19 30-46 46-65 49l3 33-11 31Z" fill="url(#stage-hair)" />
        <path d="M94 162c8-50 28-77 60-85m34 15c31 10 52 33 60 62m-124-1c25-16 41-33 50-60m-67 90c-1 47-14 76-11 98m162-103c3 47 16 74 12 97" fill="none" stroke="#ffe2aa" strokeWidth="1.2" opacity=".68" />
        <path d="M173 283c-17-15-37-17-51-16l7 30 24 2-16 35 25-7 18-30 18 30 25 7-16-35 24-2 7-30c-14-1-34 1-51 16Z" fill="#16294d" stroke="#7a91b6" strokeWidth="1.4" />
        <path d="m180 280 9 9-9 10-9-10Z" fill="#f2ce88" />
      </g>
    </svg>
  );
}
