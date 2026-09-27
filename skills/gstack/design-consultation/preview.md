# Design preview

Create a portable HTML preview matching the proposed system and product. Use real product terminology and clearly labeled sample data; never fabricate testimonials or customer claims.

Show the proposed fonts in their roles, meaningful color pairings, representative controls and one or more relevant layouts. Include responsive behavior and the product's supported themes; do not add dark mode by default when out of scope. Show icons/imagery only when they belong to the direction.

Verify font availability and delivery (self-hosted assets or a confirmed provider); a font-family declaration alone does not prove it loaded. In the browser inspect the actual font loading state and rendered result. Check fallback behavior and layout shift. `font-display: optional` may retain a fallback font; it does not guarantee zero shift in every layout.

Calculate contrast from the actual foreground/background colors, including compositing where relevant. WCAG AA text thresholds: normal 4.5:1; large 3:1 at 18pt/24px regular or 14pt/about 18.67px bold. If displaying AAA badges, use 7:1 normal and 4.5:1 large. Use the correct threshold for each rendered specimen, not a blanket palette-wide pass badge.

Inspect desktop and narrow layouts, keyboard/focus behavior and reduced motion when animation exists. Where the browser tool supports script evaluation, collect font loading state, contrast, focus order, console errors and failed requests in one scripted evaluation per load and capture both layouts in one pass; the checks are unchanged. Confirm the preview uses the proposed font, spacing and controls before delivery. If browser inspection is unavailable, label that verification incomplete. Provide a direct artifact link and concise rationale for the design source.
