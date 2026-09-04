import type { GlobalThemeOverrides } from "naive-ui";

const common = {
  primaryColor: "#5B8DEF",
  primaryColorHover: "#78A0F2",
  primaryColorPressed: "#4A78D6",
  primaryColorSuppl: "#5B8DEF",
  successColor: "#3DBE7A",
  warningColor: "#E3A23A",
  errorColor: "#E5615B",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif',
  fontFamilyMono: '"SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Mono", Consolas, monospace',
  borderRadius: "8px",
  borderRadiusSmall: "6px",
  fontSize: "13px",
  fontSizeSmall: "12px",
};

export const darkOverrides: GlobalThemeOverrides = {
  common: {
    ...common,
    bodyColor: "#141416",
    cardColor: "#1c1c21",
    modalColor: "#1f1f25",
    popoverColor: "#26262d",
    inputColor: "rgba(255,255,255,0.045)",
    inputColorDisabled: "rgba(255,255,255,0.02)",
    borderColor: "rgba(255,255,255,0.09)",
    dividerColor: "rgba(255,255,255,0.07)",
    hoverColor: "rgba(255,255,255,0.06)",
    textColorBase: "#e8e8ec",
    textColor1: "#ededf1",
    textColor2: "#c8c8d0",
    textColor3: "#8c8c96",
    placeholderColor: "#6c6c76",
  },
  Button: { fontWeight: "500" },
  Tag: { borderRadius: "999px" },
};

export const lightOverrides: GlobalThemeOverrides = {
  common: {
    ...common,
    primaryColor: "#3B6FD6",
    primaryColorHover: "#5584E0",
    primaryColorPressed: "#2F5CB8",
    primaryColorSuppl: "#3B6FD6",
    bodyColor: "#f5f5f7",
    cardColor: "#ffffff",
    modalColor: "#ffffff",
    popoverColor: "#ffffff",
    inputColor: "rgba(0,0,0,0.035)",
    inputColorDisabled: "rgba(0,0,0,0.02)",
    borderColor: "rgba(0,0,0,0.12)",
    dividerColor: "rgba(0,0,0,0.09)",
    hoverColor: "rgba(0,0,0,0.05)",
    textColorBase: "#1c1c21",
    textColor1: "#1c1c21",
    textColor2: "#3d3d46",
    textColor3: "#74747e",
    placeholderColor: "#9a9aa3",
  },
  Button: { fontWeight: "500" },
  Tag: { borderRadius: "999px" },
};

/** 兼容旧引用 */
export const themeOverrides = darkOverrides;
