import { c as _c } from "react-compiler-runtime";
import React, { createContext, useContext } from 'react';
import { Mailbox } from '../utils/mailbox.js';
const MailboxContext = createContext<Mailbox | undefined>(undefined);
type Props = {
  children: React.ReactNode;
};
export function MailboxProvider(t0) {
  const $ = _c(3);
  const {
    children
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = new Mailbox();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const mailbox = t1;
  let t2;
  if ($[1] !== children) {
    t2 = <MailboxContext.Provider value={mailbox}>{children}</MailboxContext.Provider>;
    $[1] = children;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  return t2;
}
export function useMailbox() {
  const mailbox = useContext(MailboxContext);
  if (!mailbox) {
    throw new Error("useMailbox must be used within a MailboxProvider");
  }
  return mailbox;
}
