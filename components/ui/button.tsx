import Link from "next/link";
import type { ReactNode } from "react";

type ButtonProps = {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "md" | "sm";
  /** Renders a link. Without it the button is not wired to an action yet. */
  href?: string;
  /** `submit` makes the button submit its enclosing form. */
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  children: ReactNode;
};

export function Button({
  variant = "default",
  size = "md",
  href,
  type = "button",
  disabled = false,
  className,
  children,
}: ButtonProps) {
  const classes = className ? `zf-btn ${className}` : "zf-btn";
  if (href && !disabled) {
    return (
      <Link href={href} className={classes} data-variant={variant} data-size={size}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} className={classes} data-variant={variant} data-size={size} disabled={disabled}>
      {children}
    </button>
  );
}
