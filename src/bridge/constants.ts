import { defaultWorkingDirectory, resolveDataDir } from '../portable/paths.js';

/** Host and daemon share the explicit absolute directory; otherwise isolate by profile. */
export const DATA_DIR = resolveDataDir();
export const DEFAULT_WORKING_DIR = defaultWorkingDirectory();
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
