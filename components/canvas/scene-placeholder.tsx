/**
 * Isometric line drawing standing in for the React Three Fiber viewport (wireframe 2q).
 * The real scene is owned by TASK-402 and must consume canonical runtime state.
 */
export function ScenePlaceholder() {
  return (
    <svg
      viewBox="0 90 800 480"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="3D factory scene placeholder"
    >
      <g className="zf-scene-grid">
        <path d="M160 370 L460 520" />
        <path d="M220 340 L520 490" />
        <path d="M280 310 L580 460" />
        <path d="M340 280 L640 430" />
        <path d="M160 280 L460 130" />
        <path d="M220 310 L520 160" />
        <path d="M280 340 L580 190" />
        <path d="M340 370 L640 220" />
        <path d="M400 400 L700 250" />
      </g>
      <path className="zf-scene-floor" d="M100 400 L400 250 L700 400 L400 550 Z" />
      <g className="zf-scene-mesh" data-tone="run">
        <path d="M230 290 l60 -30 l60 30 l-60 30 z M230 290 v60 l60 30 v-60 M350 290 v60 l-60 30" />
        <text x={236} y={400}>
          S7-1200-1214C-01
        </text>
      </g>
      <g className="zf-scene-mesh" data-tone="run">
        <path d="M150 370 l30 -15 l30 15 l-30 15 z M150 370 v26 l30 15 v-26 M210 370 v26 l-30 15" />
        <text x={138} y={430}>
          PT-101 · 3.08 bar
        </text>
      </g>
      <g className="zf-scene-mesh" data-tone="run">
        <path d="M410 350 l40 -20 l40 20 l-40 20 z M410 350 v46 l40 20 v-46 M490 350 v46 l-40 20" />
        <text x={416} y={440}>
          VFD-01 · 44.8 Hz
        </text>
      </g>
      <g className="zf-scene-mesh" data-tone="run">
        <ellipse cx={560} cy={330} rx={22} ry={11} />
        <path d="M538 330 v-30 a22 11 0 0 1 44 0 v30" />
        <ellipse cx={560} cy={300} rx={22} ry={11} />
        <text x={560} y={278} textAnchor="middle">
          MOTOR-01 · 1438 rpm
        </text>
      </g>
      <g className="zf-scene-mesh" data-selected="true">
        <ellipse cx={640} cy={400} rx={34} ry={17} />
        <path d="M606 400 v-36 a34 17 0 0 1 68 0 v36" />
        <ellipse cx={640} cy={364} rx={34} ry={17} />
        <path d="M640 364 l13 -7 M640 364 l-6 -14" />
        <text x={596} y={445}>
          PUMP-01 · 14.2 m³/h
        </text>
      </g>
      <path className="zf-scene-link" d="M290 320 L410 360" />
      <path className="zf-scene-link" d="M210 385 L230 320" />
      <path className="zf-scene-link" d="M490 370 L538 345" />
      <path className="zf-scene-link" d="M582 330 L606 380" />
      <g className="zf-scene-mesh" data-external="true">
        <rect x={640} y={120} width={100} height={52} />
        <text x={650} y={142}>
          gateway-01 (ext)
        </text>
        <text x={650} y={158} className="zf-scene-meta">
          host:15021
        </text>
      </g>
    </svg>
  );
}
