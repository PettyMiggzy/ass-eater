export async function getServerSideProps() {
  return { redirect: { destination: '/admin', permanent: false } };
}

export default function AdminUploadRedirect() {
  return null;
}
