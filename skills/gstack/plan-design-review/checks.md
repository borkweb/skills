# Design plan checks

Use the existing design system and the actual task. Each check is conditional on its surface being in scope.

- Information architecture: entrypoint, priority of content, labels, navigation and realistic copy.
- Interaction: default, empty, loading, success, error, disabled, focus, hover, selection and overflow states; recovery and cancellation where needed.
- Journey: how users enter, complete the task and understand the result. Connect perceived performance and progress feedback to actual delays.
- Visual system: existing tokens/components, typography, spacing, hierarchy and intentional variation. Do not call a familiar font or grid defective on style alone.
- Responsive behavior: content reflow, touch targets, zoom and the relevant viewport extremes; no hidden essential controls.
- Accessibility: semantics, labels, keyboard order, visible focus, announcements and contrast. At WCAG AA, normal text needs 4.5:1; large text is at least 18pt (24px) regular or 14pt (about 18.67px) bold and needs 3:1. Check relevant exceptions against the standard.
- Motion: purpose, duration, interruption and reduced-motion behavior when animation is present.
- Theming: existing supported themes and contrast; do not add dark mode unless part of the scope.
- Decisions: component contract, data assumptions, unresolved states and what rendered evidence will establish acceptance.
