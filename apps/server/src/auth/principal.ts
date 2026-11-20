/** A person signed in through the web app. Only admins sign in. */
export type UserPrincipal = {
  kind: "user";
  id: string;
  email: string;
  name: string;
  image: string | null;
  isAdmin: boolean;
};

export type Principal = UserPrincipal;
