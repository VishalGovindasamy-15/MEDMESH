import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgTextNode } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { mono, radius, space, type as typeScale, type Tokens } from '../theme/tokens';
import { Icon } from './Icon';

/* ------------------------------------------------------------------ layout */

type StackProps = {
  children?: React.ReactNode;
  /** Spacing token, or a raw pixel value when the 4px grid does not fit. */
  gap?: keyof typeof space | number;
  direction?: 'row' | 'column';
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  wrap?: boolean;
  style?: StyleProp<ViewStyle>;
  flex?: number;
};

export function Stack({
  children,
  gap = 'sm',
  direction = 'column',
  align,
  justify,
  wrap,
  style,
  flex,
}: StackProps) {
  const resolved = typeof gap === 'number' ? gap : space[gap];

  return (
    <View
      style={[
        {
          flexDirection: direction,
          gap: resolved,
          alignItems: align,
          justifyContent: justify,
          flexWrap: wrap ? 'wrap' : 'nowrap',
          flex,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export const Row = (props: Omit<StackProps, 'direction'>) => <Stack {...props} direction="row" />;

export function Divider({ inset = 0 }: { inset?: number }) {
  const { t } = useTheme();
  return (
    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line.base, marginHorizontal: inset }} />
  );
}

export function Card({
  children,
  style,
  padded = true,
  tone,
  elevated,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  tone?: keyof Tokens['status'];
  elevated?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: t.bg.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tone ? `${t.status[tone].base}55` : t.line.base,
          padding: padded ? space.lg : 0,
          shadowColor: t.shadow.color,
          shadowOpacity: elevated ? t.shadow.opacity : 0,
          shadowRadius: t.shadow.radius,
          shadowOffset: { width: 0, height: t.shadow.offsetY },
          elevation: elevated ? t.shadow.elevation : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/* -------------------------------------------------------------------- type */

export function Display({ children, style, ...rest }: TextProps) {
  const { t } = useTheme();
  return (
    <Text {...rest} style={[typeScale.display, { color: t.fg.strong }, style]}>
      {children}
    </Text>
  );
}

export function Title({ children, style, ...rest }: TextProps) {
  const { t } = useTheme();
  return (
    <Text {...rest} style={[typeScale.title, { color: t.fg.strong }, style]}>
      {children}
    </Text>
  );
}

export function Heading({ children, style, ...rest }: TextProps) {
  const { t } = useTheme();
  return (
    <Text {...rest} style={[typeScale.heading, { color: t.fg.strong }, style]}>
      {children}
    </Text>
  );
}

export function Body({ children, style, muted, ...rest }: TextProps & { muted?: boolean }) {
  const { t } = useTheme();
  return (
    <Text {...rest} style={[typeScale.body, { color: muted ? t.fg.muted : t.fg.base }, style]}>
      {children}
    </Text>
  );
}

export function Small({ children, style, muted, ...rest }: TextProps & { muted?: boolean }) {
  const { t } = useTheme();
  return (
    <Text {...rest} style={[typeScale.small, { color: muted ? t.fg.muted : t.fg.base }, style]}>
      {children}
    </Text>
  );
}

/**
 * Uppercase field label — used for every structural label in the app, so section
 * headers, table columns and form fields all share one voice.
 */
export function Label({ children, style, tone, ...rest }: TextProps & { tone?: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...rest}
      style={[typeScale.micro, { color: tone ?? t.fg.faint, textTransform: 'uppercase' }, style]}
    >
      {children}
    </Text>
  );
}

/**
 * Numeric readout. Tabular figures align column-to-column, which is the point:
 * an operator scanning a table of bed counts should be comparing digits, not
 * hunting for where each number begins.
 */
export function Num({
  children,
  size = 14,
  weight = '600',
  color,
  style,
}: {
  children: React.ReactNode;
  size?: number;
  weight?: TextStyle['fontWeight'];
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  const { t } = useTheme();
  return (
    <Text
      style={[
        {
          fontFamily: mono,
          fontSize: size,
          fontWeight: weight,
          color: color ?? t.fg.strong,
          fontVariant: ['tabular-nums'],
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/* ------------------------------------------------------------------- atoms */

export function Pill({
  label,
  tone = 'neutral',
  icon,
  compact,
  outline,
}: {
  label: string;
  tone?: keyof Tokens['status'] | 'accent';
  icon?: string;
  compact?: boolean;
  outline?: boolean;
}) {
  const { t } = useTheme();
  const c = tone === 'accent' ? { base: t.accent.base, soft: t.accent.soft } : t.status[tone];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: compact ? 6 : 8,
        paddingVertical: compact ? 2 : 3.5,
        borderRadius: radius.sm,
        backgroundColor: outline ? 'transparent' : c.soft,
        borderWidth: outline ? StyleSheet.hairlineWidth : 0,
        borderColor: `${c.base}66`,
        /* RN-web defaults flexShrink to 0, so a pill with a long label (a
           Tamil stage name, a district) forced its whole row wider than a
           360px phone instead of letting the text ellipsize. */
        flexShrink: 1,
      }}
    >
      {icon ? <Icon name={icon} size={11} color={c.base} strokeWidth={2} /> : null}
      <Text
        numberOfLines={1}
        style={{
          fontSize: compact ? 10 : 11,
          lineHeight: compact ? 14 : 15,
          fontWeight: '600',
          letterSpacing: 0.3,
          color: c.base,
          textTransform: compact ? 'uppercase' : 'none',
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function StatusDot({ tone, size = 7 }: { tone: keyof Tokens['status']; size?: number }) {
  const { t } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 8 8">
      <Circle cx={4} cy={4} r={4} fill={t.status[tone].base} />
    </Svg>
  );
}

/**
 * Labelled horizontal meter. One shared implementation so every bar in the app
 * has identical height, radius and track colour.
 */
export function Meter({
  value,
  total,
  tone = 'info',
  height = 4,
}: {
  value: number;
  total: number;
  tone?: keyof Tokens['status'];
  height?: number;
}) {
  const { t } = useTheme();
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  return (
    <View
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: t.line.subtle,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <View
        style={{
          width: `${pct * 100}%`,
          height,
          backgroundColor: t.status[tone].base,
          borderRadius: height / 2,
        }}
      />
    </View>
  );
}

export function Stat({
  label,
  value,
  unit,
  tone,
  sub,
  meter,
  align = 'flex-start',
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  tone?: keyof Tokens['status'];
  sub?: string;
  meter?: { value: number; total: number };
  align?: ViewStyle['alignItems'];
}) {
  const { t } = useTheme();
  const colour = tone ? t.status[tone].base : t.fg.strong;
  return (
    <View style={{ alignItems: align, gap: 5, flex: 1, minWidth: 72 }}>
      <Label>{label}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
        <Num size={21} color={colour} weight="600">
          {value}
        </Num>
        {unit ? (
          <Num size={11} color={t.fg.faint} weight="500">
            {unit}
          </Num>
        ) : null}
      </View>
      {meter ? <Meter value={meter.value} total={meter.total} tone={tone ?? 'info'} height={3} /> : null}
      {sub ? <Text style={[typeScale.nano, { color: t.fg.faint, letterSpacing: 0.2 }]}>{sub}</Text> : null}
    </View>
  );
}

/* ----------------------------------------------------------------- buttons */

export function Button({
  label,
  onPress,
  variant = 'secondary',
  icon,
  iconRight,
  disabled,
  loading,
  size = 'md',
  tone,
  full,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'tone';
  icon?: string;
  iconRight?: string;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
  tone?: keyof Tokens['status'];
  full?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const { t } = useTheme();
  const semantic = tone ? t.status[tone] : null;
  const palette = {
    primary: { bg: t.accent.base, fg: t.accent.on, border: t.accent.base },
    secondary: { bg: t.bg.surface, fg: t.fg.base, border: t.line.strong },
    ghost: { bg: 'transparent', fg: t.fg.muted, border: 'transparent' },
    danger: { bg: t.status.critical.base, fg: '#ffffff', border: t.status.critical.base },
    tone: { bg: semantic?.base ?? t.accent.base, fg: '#ffffff', border: semantic?.base ?? t.accent.base },
  }[variant];

  const dims = {
    sm: { py: 6, px: 10, size: 12.5, icon: 13 },
    md: { py: 9, px: 14, size: 13.5, icon: 15 },
    lg: { py: 13, px: 18, size: 15, icon: 17 },
  }[size];

  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingVertical: dims.py,
          paddingHorizontal: dims.px,
          backgroundColor: palette.bg,
          borderWidth: variant === 'ghost' ? 0 : StyleSheet.hairlineWidth,
          borderColor: palette.border,
          borderRadius: radius.md,
          opacity: isDisabled ? 0.45 : pressed ? 0.78 : 1,
          alignSelf: full ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : icon ? (
        <Icon name={icon} size={dims.icon} color={palette.fg} strokeWidth={2} />
      ) : null}
      <Text style={{ fontSize: dims.size, fontWeight: '600', color: palette.fg, letterSpacing: -0.1 }}>
        {label}
      </Text>
      {iconRight && !loading ? (
        <Icon name={iconRight} size={dims.icon} color={palette.fg} strokeWidth={2} />
      ) : null}
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  tone,
  size = 34,
  label,
}: {
  icon: string;
  onPress?: () => void;
  tone?: keyof Tokens['status'];
  size?: number;
  label?: string;
}) {
  const { t } = useTheme();
  const colour = tone ? t.status[tone].base : t.fg.muted;
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label ?? icon}
      accessibilityRole="button"
      hitSlop={6}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.line.base,
        backgroundColor: pressed ? t.bg.sunken : t.bg.surface,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} color={colour} strokeWidth={1.9} />
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  scroll,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  scroll?: boolean;
}) {
  const { t } = useTheme();
  const strip = (
    <View
      style={{
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        backgroundColor: t.bg.sunken,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.line.subtle,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => ({
              paddingVertical: size === 'sm' ? 5 : 7,
              paddingHorizontal: size === 'sm' ? 10 : 12,
              borderRadius: radius.sm,
              backgroundColor: active ? t.bg.surface : 'transparent',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: active ? t.line.base : 'transparent',
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Text
              style={{
                fontSize: size === 'sm' ? 12 : 12.5,
                fontWeight: active ? '600' : '500',
                color: active ? t.fg.strong : t.fg.muted,
              }}
            >
              {opt.label}
              {opt.count != null ? `  ${opt.count}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (scroll) {
    return (
      /* Width must be capped by the parent, or a 38-option control pushes its
         card past the viewport on a phone instead of becoming scrollable.
         `flexShrink` + `minWidth: 0` does that on the row axis, where the
         overflow lives, and stays inert on the column axis. The earlier
         `flexBasis: 0` capped the right axis by accident: inside a column
         parent the basis is the *height*, so the control collapsed to a
         sliver and its options were neither visible nor clickable — which is
         how the dispatch console's hold picker came to render its label and
         its explanation with no control between them. */
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexShrink: 1, minWidth: 0 }}>
        {strip}
      </ScrollView>
    );
  }
  return strip;
}

/* ------------------------------------------------------------------ inputs */

export function TextField({
  value,
  onChangeText,
  placeholder,
  label,
  icon,
  secureTextEntry,
  autoCapitalize,
  keyboardType,
  multiline,
  style,
  hint,
  maxLength,
  editable = true,
  selectTextOnFocus,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  label?: string;
  icon?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'number-pad' | 'phone-pad';
  multiline?: boolean;
  style?: StyleProp<ViewStyle>;
  hint?: string;
  maxLength?: number;
  editable?: boolean;
  selectTextOnFocus?: boolean;
}) {
  const { t } = useTheme();
  const [focused, setFocused] = React.useState(false);
  return (
    <View style={[{ gap: 5 }, style]}>
      {label ? <Label>{label}</Label> : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          gap: 8,
          backgroundColor: editable ? t.bg.surface : t.bg.sunken,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: focused ? t.accent.base : t.line.base,
          borderRadius: radius.md,
          paddingHorizontal: 11,
          paddingVertical: Platform.OS === 'ios' ? 10 : 7,
        }}
      >
        {icon ? (
          <View style={{ paddingTop: multiline ? 2 : 0 }}>
            <Icon name={icon} size={15} color={focused ? t.accent.base : t.fg.faint} strokeWidth={1.9} />
          </View>
        ) : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={t.fg.faint}
          secureTextEntry={secureTextEntry}
          autoCapitalize={autoCapitalize ?? 'sentences'}
          autoCorrect={false}
          keyboardType={keyboardType}
          selectTextOnFocus={selectTextOnFocus}
          multiline={multiline}
          editable={editable}
          maxLength={maxLength}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            /* A web <input> has a ~180px intrinsic minimum width that RN-web
               does not reset, so a field in a narrow column (two coordinate
               inputs side by side on a phone) forced its row wider than the
               viewport. minWidth: 0 lets flex do its job. */
            minWidth: 0,
            fontSize: 14.5,
            color: t.fg.strong,
            paddingVertical: 0,
            minHeight: multiline ? 56 : undefined,
            textAlignVertical: multiline ? 'top' : 'center',
          }}
        />
      </View>
      {hint ? <Text style={[typeScale.nano, { color: t.fg.faint }]}>{hint}</Text> : null}
    </View>
  );
}

/**
 * A confirmation step before an action that cannot be taken back.
 *
 * Two things are true of every destructive control in an ops console: it sits
 * next to the control that does the safe thing, and the person pressing it is
 * holding a phone call. Committing a unit, withdrawing a destination, taking an
 * account out of service -- each of those is a single misclick away from the
 * button beside it, and each is expensive to undo. This is the shared step.
 *
 * When `requireReason` is set the dialog also collects a short justification and
 * refuses to confirm until it is long enough to be useful. An override that the
 * audit trail records as "operator override" records nothing; the point of the
 * trail is that somebody reviewing it later can see what the operator knew that
 * the engine did not.
 */
export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  requireReason = false,
  reasonLabel = 'Reason',
  reasonHint,
  reasonMinLength = 12,
  onConfirm,
  onCancel,
  children,
}: {
  visible: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  reasonHint?: string;
  reasonMinLength?: number;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTheme();
  const [reason, setReason] = React.useState('');

  // A fresh dialog must not arrive pre-filled with the last one's justication.
  React.useEffect(() => {
    if (visible) setReason('');
  }, [visible, title]);

  const short = requireReason && reason.trim().length < reasonMinLength;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(6, 10, 15, 0.62)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.lg,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 460,
            backgroundColor: t.bg.surface,
            borderRadius: radius.lg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.line.strong,
            padding: space.lg,
            gap: space.md,
          }}
        >
          <Row gap="sm" align="center">
            <Icon
              name={tone === 'danger' ? 'alert' : 'check'}
              size={16}
              color={tone === 'danger' ? t.status.critical.base : t.accent.base}
            />
            <Heading style={{ flex: 1 }}>{title}</Heading>
          </Row>

          {body ? (
            typeof body === 'string' ? (
              <Body muted style={{ fontSize: 13, lineHeight: 19 }}>
                {body}
              </Body>
            ) : (
              body
            )
          ) : null}

          {children}

          {requireReason ? (
            <TextField
              label={reasonLabel}
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. caller confirmed the patient is on a ventilator"
              multiline
              maxLength={200}
              hint={reasonHint ?? `Recorded against your account. ${reasonMinLength} characters minimum.`}
            />
          ) : null}

          <Row gap="sm" justify="flex-end" wrap>
            <Button label={cancelLabel} variant="ghost" onPress={onCancel} disabled={busy} />
            <Button
              label={confirmLabel}
              variant={tone === 'danger' ? 'danger' : 'primary'}
              onPress={() => onConfirm(requireReason ? reason.trim() : undefined)}
              loading={busy}
              disabled={busy || short}
              icon={tone === 'danger' ? 'alert' : 'check'}
            />
          </Row>

          {requireReason && short ? (
            <Small muted style={{ fontSize: 11.5 }}>
              {reason.trim().length === 0
                ? 'A reason is required — this action is recorded in the audit trail.'
                : `${reasonMinLength - reason.trim().length} more character${
                    reasonMinLength - reason.trim().length === 1 ? '' : 's'
                  } needed.`}
            </Small>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

export function SwitchRow({
  label,
  description,
  value,
  onChange,
  tone,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  tone?: keyof Tokens['status'];
}) {
  const { t } = useTheme();
  const colour = tone ? t.status[tone] : t.accent;
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <View
        style={{
          width: 34,
          height: 20,
          borderRadius: radius.pill,
          backgroundColor: value ? colour.base : t.line.base,
          padding: 2,
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: '#ffffff',
            alignSelf: value ? 'flex-end' : 'flex-start',
          }}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13.5, fontWeight: '500', color: t.fg.base }}>{label}</Text>
        {description ? <Text style={[typeScale.nano, { color: t.fg.faint }]}>{description}</Text> : null}
      </View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ charts */

export function Sparkline({
  data,
  width = 120,
  height = 30,
  colour,
  fill = true,
}: {
  data: number[];
  width?: number;
  height?: number;
  colour?: string;
  fill?: boolean;
}) {
  const { t } = useTheme();
  const stroke = colour ?? t.accent.base;
  if (data.length < 2) return <View style={{ width, height }} />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = width / (data.length - 1);

  const pts = data.map((d, i) => {
    const x = i * stepX;
    const y = height - 3 - ((d - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = pts.join(' ');
  const area = `${line} ${width},${height} 0,${height}`;
  const last = pts[pts.length - 1].split(',');

  return (
    <Svg width={width} height={height}>
      {fill ? <Polyline points={area} fill={stroke} fillOpacity={0.1} stroke="none" /> : null}
      <Polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <Circle cx={Number(last[0])} cy={Number(last[1])} r={2.3} fill={stroke} />
    </Svg>
  );
}

export function TrendChart({
  series,
  labels,
  height = 132,
  width,
  unit = '',
}: {
  series: { data: number[]; colour: string; label: string }[];
  labels?: string[];
  height?: number;
  width: number;
  unit?: string;
}) {
  const { t } = useTheme();
  const all = series.flatMap((s) => s.data);
  if (!all.length || width <= 0) return <View style={{ height }} />;

  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const padL = 34;
  const padB = 18;
  const plotW = Math.max(10, width - padL - 6);
  const plotH = height - padB - 8;

  const xAt = (i: number, n: number) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yAt = (v: number) => 8 + plotH - ((v - min) / span) * plotH;

  const gridCount = 3;
  const labelEvery = labels ? Math.max(1, Math.ceil(labels.length / 4)) : 0;

  return (
    <Svg width={width} height={height}>
      {Array.from({ length: gridCount + 1 }).map((_, i) => {
        const g = i / gridCount;
        const y = 8 + plotH * g;
        const val = Math.round(max - span * g);
        return (
          <React.Fragment key={i}>
            <Line
              x1={padL}
              x2={width - 6}
              y1={y}
              y2={y}
              stroke={t.chart.grid}
              strokeWidth={1}
              strokeDasharray={i === gridCount ? undefined : '3,3'}
            />
            <SvgTextNode
              x={padL - 6}
              y={y + 3.5}
              fill={t.fg.faint}
              fontSize={9}
              textAnchor="end"
              fontFamily={mono}
            >
              {`${val}${unit}`}
            </SvgTextNode>
          </React.Fragment>
        );
      })}

      {series.map((s, si) => (
        <Polyline
          key={si}
          points={s.data.map((d, i) => `${xAt(i, s.data.length).toFixed(1)},${yAt(d).toFixed(1)}`).join(' ')}
          fill="none"
          stroke={s.colour}
          strokeWidth={1.7}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}

      {labels?.map((l, i) =>
        i % labelEvery === 0 ? (
          <SvgTextNode
            key={`l${i}`}
            x={xAt(i, labels.length)}
            y={height - 4}
            fill={t.fg.faint}
            fontSize={8.5}
            textAnchor="middle"
            fontFamily={mono}
          >
            {l}
          </SvgTextNode>
        ) : null,
      )}
    </Svg>
  );
}

/* ------------------------------------------------------------------ states */

export function EmptyState({
  icon = 'info',
  title,
  body,
  action,
}: {
  icon?: string;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxl, paddingHorizontal: space.xl, gap: space.sm }}>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.lg,
          backgroundColor: t.bg.sunken,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.line.base,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={19} color={t.fg.faint} />
      </View>
      <Heading style={{ textAlign: 'center' }}>{title}</Heading>
      {body ? (
        <Small muted style={{ textAlign: 'center', maxWidth: 340 }}>
          {body}
        </Small>
      ) : null}
      {action ? <View style={{ marginTop: space.xs }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useTheme();
  return (
    <View style={{ padding: space.xxl, alignItems: 'center', gap: space.sm }}>
      <ActivityIndicator color={t.accent.base} />
      {label ? <Small muted>{label}</Small> : null}
    </View>
  );
}

export function Banner({
  tone = 'info',
  icon = 'info',
  title,
  body,
  action,
}: {
  tone?: keyof Tokens['status'];
  icon?: string;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  const { t } = useTheme();
  const c = t.status[tone];
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 10,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: c.soft,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: `${c.base}44`,
      }}
    >
      <Icon name={icon} size={16} color={c.base} strokeWidth={1.9} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: c.base }}>{title}</Text>
        {body ? <Text style={{ fontSize: 12.5, color: c.base, opacity: 0.92 }}>{body}</Text> : null}
        {action}
      </View>
    </View>
  );
}

export function KeyValue({
  label,
  children,
  dense,
  last,
}: {
  label: string;
  children: React.ReactNode;
  dense?: boolean;
  last?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.md,
        paddingVertical: dense ? 5 : 7,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: t.line.subtle,
      }}
    >
      <Text style={{ fontSize: 12.5, color: t.fg.muted }}>{label}</Text>
      <View style={{ alignItems: 'flex-end', flexShrink: 1 }}>
        {typeof children === 'string' || typeof children === 'number' ? (
          <Body style={{ fontSize: 12.5, textAlign: 'right' }}>{children}</Body>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

export function SectionHeader({
  label,
  action,
  style,
}: {
  label: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
        style,
      ]}
    >
      <Label>{label}</Label>
      {action}
    </View>
  );
}

export function TrustChip({ score, band }: { score?: number | null; band?: string }) {
  const { t } = useTheme();
  if (score == null) return null;
  const tone: keyof Tokens['status'] = score >= 80 ? 'live' : score >= 55 ? 'warm' : 'stale';
  const c = t.status[tone];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Svg width={12} height={12} viewBox="0 0 16 16">
        <Circle cx={8} cy={8} r={6.4} stroke={c.base} strokeWidth={1.6} fill="none" opacity={0.35} />
        <Circle
          cx={8}
          cy={8}
          r={6.4}
          stroke={c.base}
          strokeWidth={1.6}
          fill="none"
          strokeDasharray={`${(score / 100) * 40.2} 40.2`}
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      </Svg>
      <Text style={{ fontSize: 11, fontWeight: '600', color: c.base, letterSpacing: 0.2 }}>
        {score}
        <Text style={{ color: t.fg.faint, fontWeight: '500' }}>{band ? ` ${band}` : ''}</Text>
      </Text>
    </View>
  );
}
