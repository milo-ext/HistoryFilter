"""Focused release regressions in disposable Chrome/Firefox profiles only."""
import argparse
import json
import tempfile
from pathlib import Path
from browser_tools import add_firefox_arguments, firefox_tool_paths
from browser_release import wait_for

ROOT = Path(__file__).resolve().parents[1]


def api_checks(evaluate):
    # evaluate executes inside the extension options page; every write is a
    # fixture in the disposable profile or a real options-to-background message.
    state = evaluate("return await api.storage.local.get('history_rules');")
    assert state['history_rules'][0]['enabled'] is False
    evaluate("await api.storage.local.set({history_rules:[]});")
    added = evaluate("""
      const requests = Array.from({length:20}, (_,i) => api.runtime.sendMessage({
        action:'mutateRules',operation:'add',rule:{name:'Concurrent '+i,enabled:true,
        matchType:'domain',pattern:'concurrent.qa.invalid',action:'block'}}));
      const results = await Promise.all(requests);
      if(results.some(r=>r.error)) throw new Error('Rule save failed');
      return (await api.storage.local.get('history_rules')).history_rules;
    """)
    assert len(added) == 20 and len({r['id'] for r in added}) == 20
    evaluate("""
      await api.runtime.sendMessage({action:'clearLogs'});
      await Promise.all(Array.from({length:20},(_,i)=>api.history.addUrl({url:'https://concurrent.qa.invalid/'+i})));
    """)
    wait_for(lambda: len(evaluate("return (await api.storage.local.get('history_logs')).history_logs || [];")) == 20,
             'all concurrent history events logged', timeout=15)
    assert not evaluate("return await api.history.search({text:'concurrent.qa.invalid',startTime:1});")
    print('PASS 20 concurrent rule saves and 20 concurrent history/log writes')
    evaluate("""
      await api.storage.local.set({history_rules:[
        {id:'normalize',name:'Normalize',enabled:true,matchType:'domain',pattern:'guard.qa.invalid',queryKey:'q',action:'normalize',normalizeOptions:{keepOriginOnly:true}},
        {id:'block',name:'Block target on real visit',enabled:true,matchType:'domain',pattern:'guard.qa.invalid',action:'block'}]});
      await api.history.addUrl({url:'https://guard.qa.invalid/source?q=1'});
    """)
    wait_for(lambda: evaluate("return (await api.history.search({text:'guard.qa.invalid',startTime:1})).some(i=>i.url==='https://guard.qa.invalid/');"), 'generated target kept')
    evaluate("await api.history.addUrl({url:'https://guard.qa.invalid/'});")
    wait_for(lambda: not evaluate("return await api.history.search({text:'guard.qa.invalid',startTime:1});"), 'immediate target revisit processed', timeout=3)
    print('PASS generated event protected, immediate real revisit processed')
    evaluate("""
      await api.storage.local.set({history_rules:[{id:'legacy',name:'Legacy',enabled:true,matchType:'regex',pattern:'(a+)+$',action:'block'}]});
      await api.history.addUrl({url:'https://regex.qa.invalid/'+'a'.repeat(32)+'!'});
    """)
    assert evaluate("return (await api.runtime.sendMessage({action:'getRules'})).rules.length;") == 1
    print('PASS legacy catastrophic regex does not block background messages')


def chrome(extension):
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory(prefix='hf-reliability-') as profile, sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(profile, headless=True,
            executable_path=pw.chromium.executable_path,
            args=[f'--disable-extensions-except={extension}',f'--load-extension={extension}'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            url = worker.url.split('/src/',1)[0]+'/src/options/options.html'
            a = context.new_page();a.goto(url)
            a.locator('.rule-card').first.wait_for()
            evaluate = lambda body: a.evaluate('async()=>{const api=chrome;'+body+'}')
            api_checks(evaluate)
            evaluate("await api.storage.local.set({options_locale:'en',history_rules:[{id:'shared',name:'Shared',enabled:true,matchType:'domain',pattern:'old.qa.invalid',action:'block'}]});")
            a.reload();a.locator('.edit').click()
            a.locator('#rule-name').fill('Unsaved edit')
            b = context.new_page();b.goto(url);b.locator('.edit').click()
            b.locator('#rule-pattern').fill('new.qa.invalid');b.locator('#save-rule-btn').click()
            b.locator('#rule-modal').wait_for(state='hidden')
            a.locator('#save-rule-btn').click()
            wait_for(lambda:'another tab' in a.locator('#form-error').inner_text(), 'stale editor rejected')
            assert a.locator('#rule-name').input_value() == 'Unsaved edit'
            a.locator('#cancel-btn').click()
            a.locator('.rule-enabled').locator('..').click()
            wait_for(lambda: evaluate("return (await api.storage.local.get('history_rules')).history_rules[0].enabled;") is False,'toggle saved')
            current = evaluate("return (await api.storage.local.get('history_rules')).history_rules[0];")
            assert current['pattern']=='new.qa.invalid' and current['name']=='Shared'
            wait_for(lambda: not b.locator('.rule-enabled').is_checked(),'other tab refreshed')
            a.locator('.edit').click();a.locator('#rule-match-type').select_option('regex')
            a.locator('#rule-pattern').fill('(a+)+$');a.locator('#save-rule-btn').click()
            assert a.locator('#rule-modal').is_visible()
            assert a.locator('#form-error').inner_text()
            a.locator('#cancel-btn').click()
            print('PASS two settings tabs preserve changes, reject stale edits, refresh toggles; regex editor refuses unsafe pattern')
        finally: context.close()


def firefox(extension, geckodriver, firefox_binary):
    from firefox_release import Options, Service, webdriver, install_extension, api, click, fill, eventually, By
    opts=Options();opts.binary_location=str(firefox_binary);opts.add_argument('-headless')
    driver=webdriver.Firefox(service=Service(str(geckodriver),service_args=['--allow-system-access']),options=opts)
    driver.set_script_timeout(20)
    try:
        assert 'rust_mozprofile' in driver.capabilities['moz:profile']
        addon=install_extension(driver,extension)
        driver.set_context('chrome')
        uuids=json.loads(driver.execute_script('return Services.prefs.getStringPref("extensions.webextensions.uuids")'))
        driver.set_context('content');url=f'moz-extension://{uuids[addon]}/src/options/options.html';driver.get(url)
        evaluate=lambda body:api(driver,'const api=browser;'+body)
        eventually(lambda:len(driver.find_elements(By.CSS_SELECTOR,'.rule-card'))>0,'first rule')
        api_checks(evaluate)
        evaluate("await api.storage.local.set({options_locale:'en',history_rules:[{id:'shared',name:'Shared',enabled:true,matchType:'domain',pattern:'old.qa.invalid',action:'block'}]});")
        driver.refresh();a=driver.current_window_handle
        eventually(lambda:len(driver.find_elements(By.CSS_SELECTOR,'.edit'))==1,'first settings tab ready')
        click(driver,'.edit');fill(driver,'#rule-name','Unsaved edit')
        driver.switch_to.new_window('tab');driver.get(url)
        eventually(lambda:len(driver.find_elements(By.CSS_SELECTOR,'.edit'))==1,'second settings tab ready')
        click(driver,'.edit');fill(driver,'#rule-pattern','new.qa.invalid');click(driver,'#save-rule-btn')
        eventually(lambda:not driver.find_element(By.CSS_SELECTOR,'#rule-modal').is_displayed(),'edit saved')
        b=driver.current_window_handle;driver.switch_to.window(a)
        click(driver,'#save-rule-btn')
        eventually(lambda:'another tab' in driver.find_element(By.CSS_SELECTOR,'#form-error').text,'stale edit rejected')
        click(driver,'#cancel-btn');click(driver,'.rule-enabled + span')
        eventually(lambda:evaluate("return (await api.storage.local.get('history_rules')).history_rules[0].enabled;") is False,'toggle saved')
        current=evaluate("return (await api.storage.local.get('history_rules')).history_rules[0];")
        assert current['pattern']=='new.qa.invalid' and current['name']=='Shared'
        driver.switch_to.window(b)
        eventually(lambda:not driver.find_element(By.CSS_SELECTOR,'.rule-enabled').is_selected(),'other tab refreshed')
        print('PASS Firefox two-tab conflict rejection and field-only toggle')
    finally:driver.quit()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--browser',choices=['chrome','firefox'],required=True)
    parser.add_argument('--extension',type=Path,default=ROOT)
    add_firefox_arguments(parser)
    args=parser.parse_args()
    if args.browser=='chrome':chrome(args.extension.resolve())
    else:firefox(args.extension.resolve(),*firefox_tool_paths(args,parser))
