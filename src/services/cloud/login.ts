/** Email/password sign-in flow shared by the login screen and the Cloud page. */
import { sendToSw } from '@/background/messages';
import { signIn, signOut } from './auth';
import { accountState, wipeLocalSyncedData } from './sync';

export const SWITCH_MESSAGE =
  'This browser still has data (posts, brand, groups…) from a DIFFERENT SocialPilot account.\n\n' +
  'OK = remove that local copy and load the data of the account you just signed in with.\n' +
  'Cancel = sign out again (nothing is changed).';

/**
 * Signs in. If this browser's data belongs to another account, the user must choose: replace it with this
 * account's data, or cancel (it is never uploaded into the wrong account). Then the first sync starts.
 */
export async function login(email: string, password: string, confirmSwitch: (message: string) => boolean): Promise<'ok' | 'cancelled'> {
  const s = await signIn(email, password);
  if ((await accountState(s.uid)) === 'switched') {
    if (!confirmSwitch(SWITCH_MESSAGE)) {
      await signOut();
      return 'cancelled';
    }
    await wipeLocalSyncedData();
  }
  await sendToSw({ type: 'tick' }).catch(() => undefined); // first sync: receive from the cloud, then upload what is missing
  return 'ok';
}
