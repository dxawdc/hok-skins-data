// pages/maintenance.js
export default function MaintenancePage() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '20px',
      textAlign: 'center'
    }}>
      <h1>🛠️ 网站维护中</h1>
      <p>我们正在对网站进行升级维护，预计恢复时间：</p>
      <p style={{ fontSize: '1.5em', fontWeight: 'bold' }}>
        {process.env.NEXT_PUBLIC_MAINTENANCE_UNTIL || '2小时后'}
      </p>
      <p>给您带来的不便，敬请谅解。</p>
      <div style={{ marginTop: '30px' }}>
        <p>联系支持：support@example.com</p>
      </div>
    </div>
  )
}

export async function getStaticProps() {
  return {
    props: {},
  }
}
