import { isPostOnlyRejection } from '../src/utils/orderRejection.utils';

describe('isPostOnlyRejection', () => {
  it('Binance futures -5022 GTX_ORDER_REJECT, as a number or a string', () => {
    expect(isPostOnlyRejection({ errorCode: -5022 })).toBe(true);
    expect(isPostOnlyRejection({ errorCode: '-5022' })).toBe(true);
  });

  it('Bybit rejectReason EC_PostOnlyWillTakeLiquidity on the order stream', () => {
    expect(isPostOnlyRejection({ rejectReason: 'EC_PostOnlyWillTakeLiquidity' })).toBe(true);
  });

  it('any other refusal is not a post-only one', () => {
    expect(isPostOnlyRejection({ errorCode: -2019 })).toBe(false);
    expect(isPostOnlyRejection({ errorCode: 110007 })).toBe(false);
    expect(isPostOnlyRejection({ rejectReason: 'EC_NoError' })).toBe(false);
    expect(isPostOnlyRejection({ errorCode: null, rejectReason: null })).toBe(false);
    expect(isPostOnlyRejection({})).toBe(false);
  });
});
