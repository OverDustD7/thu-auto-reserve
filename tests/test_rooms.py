import base64
import contextlib
import datetime as dt
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rooms', ROOT/'scripts/wechat-room-api.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class RoomTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.now = dt.datetime(2026,9,6,10,0,tzinfo=m.BJ)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(m,'_now',return_value=self.now))
        self.stack.enter_context(patch.object(m,'_api',side_effect=self.api))
        self.stack.enter_context(patch.object(m,'_api_full',side_effect=self.create))
        self.args=['--room','ROOM','--date','2026-09-07','--start','10:00','--end','11:00','--organizer','AUDIT',
                   '--participants','3','--subject','TEST','--usage','TEST','--type','文化活动']

    def api(self,method,endpoint,jwt,**kwargs):
        self.calls.append((method,endpoint))
        if endpoint=='/activity/rooms':
            return 200,{'value':[{'id':'ROOM-ID','name':'ROOM','capacity':10,'location':'C楼二楼','tags':['研讨']} ]}
        if endpoint=='/account/semesters':
            return 200,[{'id':'SEMESTER','start':'2026-01-01','end':'2026-12-31'}]
        if method=='GET':return 200,{'value':[]}
        return 204,{}

    def create(self,method,endpoint,jwt,**kwargs):
        self.calls.append((method,endpoint))
        return 201,{}, {'Location':'/activity/room-tickets/FAKE-TICKET'}

    def call(self,name,args):
        output=io.StringIO()
        with patch.object(sys,'argv',['script',name,*args]),contextlib.redirect_stdout(output):
            code=getattr(m,'cmd_'+name)('SYNTHETIC')
        return code,json.loads(output.getvalue())

    def test_valid_preview_does_not_post(self):
        code,result=self.call('apply',self.args)
        self.assertEqual(code,0);self.assertTrue(result['dry_run'])
        self.assertFalse(any(method=='POST' for method,_ in self.calls))

    def test_valid_submission_posts_two_steps(self):
        code,result=self.call('apply',self.args+['--yes'])
        self.assertEqual(code,0);self.assertTrue(result['ok'])
        self.assertEqual([p for method,p in self.calls if method=='POST'],['/activity/room-tickets','/activity/room-tickets/FAKE-TICKET/apply'])

    def test_invalid_inputs_never_post(self):
        for key,value in [('--participants','0'),('--participants','-1'),('--end','09:00'),('--date','2000-01-01'),('--date','2026-02-31'),('--start','08:99'),('--end','23:30')]:
            with self.subTest(key=key,value=value):
                args=self.args.copy();args[args.index(key)+1]=value;self.calls.clear()
                try: code,_=self.call('apply',args+['--yes']);self.assertNotEqual(code,0)
                except (ValueError,RuntimeError):pass
                self.assertFalse(any(method=='POST' for method,_ in self.calls))

    def test_advance_four_hours_enforced(self):
        args=self.args.copy();args[args.index('--date')+1]='2026-09-06'
        with self.assertRaises(ValueError):self.call('apply',args+['--yes'])

    def test_occupancy_failure_stops_preview_and_submit(self):
        original=self.api
        def failing(method,path,*a,**kw):
            return (503,{}) if path.endswith('/records') else original(method,path,*a,**kw)
        with patch.object(m,'_api',side_effect=failing):
            for extra in [[],['--yes']]:
                with self.assertRaises(RuntimeError):self.call('apply',self.args+extra)
        self.assertFalse(any(method=='POST' for method,_ in self.calls))

    def test_list_failure_does_not_mean_empty(self):
        with patch.object(m,'_api',return_value=(503,{})):
            with self.assertRaises(RuntimeError):self.call('mine',['--json'])

    def test_availability_failure_does_not_mean_free(self):
        original=self.api
        def failing(method,path,*a,**kw):
            return (503,{}) if path.endswith('/records') else original(method,path,*a,**kw)
        with patch.object(m,'_api',side_effect=failing):
            with self.assertRaises(RuntimeError):self.call('avail',['--from','2026-09-07','--to','2026-09-07','--json'])

    def test_past_day_not_available(self):
        _,result=self.call('avail',['--from','2026-09-05','--to','2026-09-05','--json'])
        self.assertEqual(result['rooms'],[])

    def test_today_availability_starts_four_hours_ahead(self):
        _,result=self.call('avail',['--from','2026-09-06','--to','2026-09-06','--json'])
        self.assertEqual(result['rooms'][0]['free']['2026-09-06'],[['14:00','23:00']])

    def test_cancel_and_remove_preview_by_default(self):
        for cmd in ['cancel','remove']:
            _,result=self.call(cmd,['--ticket','FAKE']);self.assertTrue(result['dry_run'])
        self.assertEqual(self.calls,[])

    def test_confirmed_remove(self):
        code,result=self.call('remove',['--ticket','FAKE','--yes'])
        self.assertEqual(code,0);self.assertTrue(result['ok'])

    def test_partial_cancel_not_full_success(self):
        with patch.object(m,'_api',side_effect=[(204,{}),(500,{})]):
            code,result=self.call('cancel',['--ticket','FAKE','--yes'])
        self.assertEqual(code,1);self.assertTrue(result['revoked']);self.assertFalse(result['removed'])

    def test_failed_revoke_never_removes(self):
        with patch.object(m,'_api',return_value=(500,{})) as api:
            code,result=self.call('cancel',['--ticket','FAKE','--yes'])
        self.assertEqual(code,1);self.assertEqual(api.call_count,1)

    def test_uncertain_apply_never_deletes(self):
        original=self.api
        def failing(method,path,*a,**kw):
            return (None,'timeout') if path.endswith('/apply') else original(method,path,*a,**kw)
        with patch.object(m,'_api',side_effect=failing):code,result=self.call('apply',self.args+['--yes'])
        self.assertEqual(code,1);self.assertEqual(result['ticket_id'],'FAKE-TICKET')
        self.assertFalse(any(path.endswith('/remove') for _,path in self.calls))

    def test_iso_timestamp_variants(self):
        expected=m._epoch_ms('2026-09-07T02:00:00.000Z')
        self.assertEqual(m._epoch_ms('2026-09-07T02:00:00Z'),expected)
        self.assertEqual(m._epoch_ms('2026-09-07T10:00:00+08:00'),expected)
        self.assertEqual(m._epoch_ms(expected),expected)

    def test_local_config_does_not_authenticate(self):
        with patch.object(m,'extract_jwt',side_effect=AssertionError('auth called')),patch.object(m,'cmd_config',return_value=0),patch.object(sys,'argv',['script','config','org','get']):
            self.assertEqual(m.main(),0)

    def test_query_without_session_does_not_scan_or_guess(self):
        with patch.object(m,'_read_saved_jwt',return_value=None),patch.object(m,'_jwt_valid',side_effect=AssertionError('network called')):
            self.assertIsNone(m.extract_jwt())
        self.assertFalse(hasattr(m,'_gather'))

    def test_unrelated_token_rejected_before_network(self):
        def enc(o):return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
        token=enc({'alg':'HS256'})+'.'+enc({'exp':4102444800,'iss':'another-app'})+'.SYNTHETIC'
        with patch.object(sys,'stdin',io.StringIO(token)),patch.object(m,'_jwt_valid',side_effect=AssertionError('network called')):
            with self.assertRaises(ValueError):m.cmd_login(['--card','123456','--stdin'])

    def test_dpapi_round_trip_and_legacy_rejection(self):
        if sys.platform!='win32':self.skipTest('Windows DPAPI')
        self.assertEqual(m._dec(m._enc('SYNTHETIC')),'SYNTHETIC')
        with self.assertRaises(ValueError):m._dec('{"jwt":"old"}')

if __name__=='__main__':unittest.main()
