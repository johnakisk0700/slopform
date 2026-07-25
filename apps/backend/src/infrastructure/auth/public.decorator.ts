import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = Symbol("join-the-six.public-route");

/** Explicit opt-out from the HTTP application's default Clerk guard. */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);
