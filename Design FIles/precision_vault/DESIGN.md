---
name: Precision Vault
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#464555'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4d44e3'
  primary: '#3525cd'
  on-primary: '#ffffff'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#c3c0ff'
  secondary: '#505f76'
  on-secondary: '#ffffff'
  secondary-container: '#d0e1fb'
  on-secondary-container: '#54647a'
  tertiary: '#005338'
  on-tertiary: '#ffffff'
  tertiary-container: '#006e4c'
  on-tertiary-container: '#7df1bd'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#d3e4fe'
  secondary-fixed-dim: '#b7c8e1'
  on-secondary-fixed: '#0b1c30'
  on-secondary-fixed-variant: '#38485d'
  tertiary-fixed: '#85f8c4'
  tertiary-fixed-dim: '#68dba9'
  on-tertiary-fixed: '#002114'
  on-tertiary-fixed-variant: '#005137'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: '600'
    lineHeight: 2rem
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Inter
    fontSize: 1.125rem
    fontWeight: '600'
    lineHeight: 1.5rem
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Inter
    fontSize: 0.9375rem
    fontWeight: '600'
    lineHeight: 1.375rem
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 0.9375rem
    fontWeight: '400'
    lineHeight: 1.5rem
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.25rem
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: '400'
    lineHeight: 1.125rem
    letterSpacing: 0em
  label-md:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: '500'
    lineHeight: 1rem
    letterSpacing: 0.005em
  label-sm:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: '500'
    lineHeight: 0.875rem
    letterSpacing: 0.01em
  code-sm:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: '500'
    lineHeight: 1rem
    letterSpacing: -0.02em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 0.75rem
  gutter-desktop: 1rem
  margin: 1rem
  margin-desktop: 1.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

This design system establishes an environment of strict privacy, structural clarity, and executive utility. Crafted for high-frequency personal information management and real-time form autofill operations, it borrows the compact keyboard-first density of command bars, the structural restraint of modern developer tooling, and the uncompromising trust of zero-knowledge client architectures.

### Aesthetic Principles
- **Restrained Architectural Rigor:** Structure is established primarily through hairline borders, precise tabular alignments, and tonal contrast rather than layered elevations or heavy shadows.
- **Earned Trust via Functionality:** Explicit state indicators, clear attribution of filled data, and deterministic field mapping replace ornamental trust seals, decorative shields, or superfluous marketing badges.
- **Compact Keyboard-Forward Density:** Elements are optimized for micro-interactions, split-second context switching, quick keystroke navigation, and inline data inspection without visual fatigue.
- **Calm, High-Information Efficiency:** Low visual noise ensures user focus remains entirely on sensitive identities, payment profiles, and multi-step autofill tasks.

## Colors

The palette is engineered around an architectural, neutral-first foundation with deliberate functional accents.

### Role Assignments
- **Canvas Base (`#F8FAFC`):** Primary window, extension shell, and root application background. Provides a warm, crisp architectural baseline.
- **Surface Elevation (`#FFFFFF`):** High-density cards, input panels, floating popovers, and table rows.
- **Surface Subdued (`#F1F5F9`):** Secondary groupings, sidebars, keyboard badge containers, and disabled field backdrops.
- **Structural Dividers (`#E2E8F0`):** Single-pixel perimeter rules, splitters, and grid lines. Subtle active stroke deepens to `#CBD5E1`.
- **Text & Foreground:**
  - **High-Contrast Text (`#0F172A`):** Critical data keys, primary field values, headers, and destructive confirmations.
  - **Secondary Text (`#64748B`):** Field labels, contextual shortcuts, timestamps, and column headers.
  - **Subtle Foreground (`#94A3B8`):** Placeholders, hotkey symbols, and inline metadata rules.
- **Functional Semantics:**
  - **Primary Indigo (`#4F46E5` default, `#4338CA` hover/pressed):** High-intent calls to action, focused stroke rings, and current selection borders.
  - **Verified Emerald (`#059669`):** Successful field validation, synchronized storage status, completed form injection.
  - **Warning Amber (`#D97706`):** Sensitive data updates, mismatched field suggestions, and expiring credentials.
  - **Destructive Red (`#DC2626`):** Vault record removal, identity profile purge, and security session invalidation.

## Typography

The type scale relies entirely on Inter to ensure clean numeric alignments, consistent tabular metrics, and maximum clarity at micro sizes (11px to 14px).

### Font Features & Metrics
- Enable OpenType features: `cv02`, `cv03`, `cv04` (distinctive 'a', 'g', and zero with cross-bar), and `tnum` (tabular figures) across all numerical data lists, credit card displays, phone formats, and identity counters.
- Tight, negative letter tracking is enforced on headlines to avoid loose modern proportions, shifting directly into positive micro-tracking for small labels (`label-sm`, `code-sm`).
- Line-height scales strictly within 4px units to guarantee deterministic baseline rhythm across compact multi-column layouts and inline form injection panels.

## Layout & Spacing

Layouts adhere to an ultra-disciplined 4px / 8px incremental system optimized for high data density, extension drop-downs, and modular dashboard panes.

### Form Factors & Adaptation
- **Extension / Flyout View (360px – 420px):** Fixed width shell with strict `0.75rem` internal margins. Single-column stacked vertical cards with `space-sm` component gaps.
- **Tablet / Split Screen (421px – 1024px):** Fluid layout structured around a collapsible navigation sidebar (240px fixed) and a responsive primary canvas using `0.75rem` gutters.
- **Desktop Dashboard (>1024px):** Dual or three-pane structural layout: persistent identity rail (260px), selectable records center list (360px), and an active field configuration inspector (fluid remainder). Outer margin stabilizes at `1.5rem`.

### Spatial Rhythm
- Compact density defaults to `space-xs` (4px) for label-to-input vertical grouping.
- Field rows within profile cards sit `space-sm` (8px) apart to keep complete form mappings viewable without vertical scrolling.
- Structural panels and cards separate at `space-lg` (16px).

## Elevation & Depth

Visual hierarchy uses flat, precise structural framing over heavy physical elevation. Planes are defined by hairline borders, contrast stacking, and minimal ambient diffusion.

### Stacking Hierarchy
- **Level 0 (Base Canvas):** Solid `#F8FAFC`. Zero elevation, zero shadows.
- **Level 1 (Structural Cards & Modules):** Solid `#FFFFFF`, bordered by `1px solid #E2E8F0`. Shadow is strictly flat or micro-diffused: `0 1px 2px 0 rgba(15, 23, 42, 0.04)`.
- **Level 2 (Dropdowns, Command Menus, Inline Action Bars):** Solid `#FFFFFF`, bordered by `1px solid #CBD5E1`. Shadow: `0 4px 6px -1px rgba(15, 23, 42, 0.07), 0 2px 4px -2px rgba(15, 23, 42, 0.05)`.
- **Level 3 (Modal Dialogs & Critical Authorization Overlays):** Solid `#FFFFFF`, framed by `1px solid #94A3B8`. Shadow: `0 20px 25px -5px rgba(15, 23, 42, 0.1), 0 8px 10px -6px rgba(15, 23, 42, 0.04)`. Backdrop utilizes a restrained dark veil: `rgba(15, 23, 42, 0.4)`.

### Focus and Active Hierarchy
- Interactive element focus discards fuzzy glows in favor of a crisp dual-ring structure: a 2px solid white offset ring surrounded by a 2px `#4F46E5` primary rule.

## Shapes

The interface employs uniform curvature balanced between technical efficiency and ergonomic softness.

### Corner Curvature Rules
- **Base Components (Inputs, Buttons, Badges, Chips):** `0.5rem` (8px / `rounded-md` to `rounded-lg`). Ensures tight alignment within dense lists without visual clipping.
- **Containers & Panels (Cards, Command Modals, Flyouts):** `0.75rem` (12px / `rounded-xl`). Provides distinct enclosure for multi-field groupings.
- **Inner Nested Elements:** Always scaled down to `0.375rem` (6px) or `0.25rem` (4px) to preserve equidistant border radii when nested inside parent cards.
- **Keyboard Shortcuts (`<kbd>`):** `0.25rem` (4px) with `1px solid #CBD5E1` bordering and a subtle bottom stroke offset.

## Components

### Buttons
- **Primary:** Background `#4F46E5`, foreground `#FFFFFF`, border none. Hover: `#4338CA`. Active: scale `0.99`. Height: 32px (compact) or 36px (regular). Text: `label-md`.
- **Secondary / Outline:** Background `#FFFFFF`, foreground `#0F172A`, border `1px solid #E2E8F0`. Hover: background `#F1F5F9`, border `#CBD5E1`.
- **Ghost:** Background transparent, foreground `#64748B`. Hover: background `#F1F5F9`, foreground `#0F172A`.
- **Destructive:** Background `#FFFFFF`, foreground `#DC2626`, border `1px solid #FECACA`. Hover: background `#FEF2F2`.

### Input Fields & Selectors
- **Structure:** Height 36px, horizontal padding `space-md` (12px), background `#FFFFFF`, border `1px solid #E2E8F0`, corner radius 8px.
- **States:** Focus produces `border-color: #4F46E5` with `box-shadow: 0 0 0 1px #4F46E5`. Error state uses `#DC2626` border and ring.
- **Embedded Controls:** Trailing elements host inline shortcut indicators, sensitive masking toggles (show/hide), and single-click copy buttons rendered in `14px` outline iconography.

### Chips & Badges
- **Status Indicators:** Height 20px, padding `0 6px`, radius 4px, font `label-sm`.
  - *Synced / Verified:* Background `#ECFDF5`, text `#065F46`, dot indicator `#059669`.
  - *Pending / Suggested:* Background `#EFF6FF`, text `#1E40AF`, dot indicator `#3B82F6`.
  - *Warning:* Background `#FFFBEB`, text `#92400E`, dot indicator `#D97706`.
- **Keyboard Badges (`<kbd>`):** Background `#F8FAFC`, border `1px solid #E2E8F0`, box-shadow `0 1px 0 #CBD5E1`, text `#64748B`, font `code-sm`.

### Lists & Field Data Tables
- **Row Rhythm:** Height 40px for single-line records, 52px for two-line metadata records.
- **Separators:** Hairline horizontal rules (`#F1F5F9`), highlighting with `#F8FAFC` on hover.
- **Keyboard Navigation Highlight:** Active cursor row indicates selection via a left-anchored 2px `#4F46E5` edge indicator and `#F8FAFC` background fill.

### Checkboxes & Radios
- **Checkboxes:** 16px by 16px square, radius 4px, border `1px solid #CBD5E1`. Checked state transitions directly to `#4F46E5` with a clean white vector checkmark.
- **Radios:** 16px circular boundary, selected state displays a 6px centered `#4F46E5` solid core.

### Cards & Field Groupings
- **Structure:** Background `#FFFFFF`, border `1px solid #E2E8F0`, radius 12px, padding `16px`.
- **Header Pattern:** Includes a structural subtitle with item counter and an explicit lock status icon (Lucide `Lock` stroke: 1.5px).

### Browser Autofill Pill (Inline Injector Overlay)
- **Appearance:** High-contrast compact capsule floating adjacent to active web inputs.
- **Styling:** Background `#FFFFFF`, border `1px solid #CBD5E1`, shadow `Level 2`. Includes profile avatar/category icon (16px), primary match label (`0.8125rem`, semibold), and an inline `<kbd>Tab</kbd>` or `<kbd>↵</kbd>` trigger badge.